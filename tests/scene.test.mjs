import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(source, 'The page must contain its campus scene script.');

// This harness runs the shipped script. It models browser scheduling rather than
// exposing private scene state, so tests exercise the same public controls as users.
function createScene({ reducedMotion = false, width = 1280, height = 900, padding = 18 } = {}) {
  const frames = new Map();
  const timers = new Map();
  const elements = new Map();
  const canvases = [];
  const downloads = [];
  const audioContexts = [];
  const revokedUrls = [];
  let nextId = 1;
  let blobFailure = false;
  let now = 0;
  let pendingResume;

  class Events {
    listeners = new Map();
    addEventListener(type, callback) {
      const list = this.listeners.get(type) || [];
      list.push(callback);
      this.listeners.set(type, list);
    }
    removeEventListener(type, callback) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== callback));
    }
    emit(type, props = {}) {
      const event = {
        target: this, currentTarget: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        ...props,
      };
      for (const callback of this.listeners.get(type) || []) callback(event);
      return event;
    }
  }

  class Element extends Events {
    constructor(tagName = 'div', id = '') {
      super();
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.attributes = new Map();
      this.style = {};
      this.textContent = '';
      this.open = false;
      this.disabled = false;
      this.isContentEditable = false;
      this.clientWidth = width;
      this.clientHeight = this.offsetHeight = id === 'app' ? 600 : tagName === 'header' ? 23 : tagName === 'footer' ? 100 : 0;
      this.parentElement = null;
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle(name, force = !classes.has(name)) {
          if (force) classes.add(name); else classes.delete(name);
          return force;
        },
      };
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    matches(selector) {
      return selector.split(',').some(part => {
        const value = part.trim().toLowerCase();
        if (value.includes('contenteditable')) return this.isContentEditable;
        return value === this.tagName.toLowerCase() || value === `#${this.id}`;
      });
    }
    closest(selector) {
      let item = this;
      while (item) { if (item.matches(selector)) return item; item = item.parentElement; }
      return null;
    }
    querySelector(selector) { return querySelector(selector); }
    querySelectorAll(selector) { return [...elements.values()].filter(item => item.matches(selector)); }
    getBoundingClientRect() {
      const boxWidth = parseFloat(this.style.width) || this.clientWidth;
      const boxHeight = this.id === 'scene' ? boxWidth * 9 / 16 : this.offsetHeight;
      return { left: 0, top: 0, right: boxWidth, bottom: boxHeight, width: boxWidth, height: boxHeight };
    }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit('close'); }
    click() {
      if (this.tagName === 'A') downloads.push({ href: this.href, download: this.download });
      if (!this.disabled) return this.emit('click', { clientX: 0, clientY: 0 });
    }
    appendChild(child) { child.parentElement = this; return child; }
    remove() { this.parentElement = null; }
  }

  class Context {
    constructor(canvas) {
      this.canvas = canvas;
      this.fillStyle = '#000000';
      this.globalAlpha = 1;
      this.imageSmoothingEnabled = true;
      this.count = 0;
      this.drawImages = [];
      this.fills = [];
      this.signature = 0;
      this.stack = [];
    }
    record(method, args) {
      this.count++;
      if (this.canvas.id !== 'scene') return;
      const value = `${method}:${args.join(',')}:${this.fillStyle}:${this.globalAlpha}`;
      for (let i = 0; i < value.length; i++) this.signature = (Math.imul(this.signature, 31) + value.charCodeAt(i)) | 0;
    }
    fillRect(...args) {
      this.record('fillRect', args);
      // Retain only full-scene weather overlays, rather than every artwork pixel.
      if (args[0] === 0 && args[1] === 0 && args[2] === 640 && args[3] === 360) {
        this.fills.push({ color: this.fillStyle, alpha: this.globalAlpha });
      }
    }
    clearRect(...args) { this.record('clearRect', args); }
    fillText(...args) { this.record('fillText', args); }
    translate(...args) { this.record('translate', args); }
    scale(...args) { this.record('scale', args); }
    drawImage(...args) { this.drawImages.push(args); this.record('drawImage', args.map(item => item instanceof Canvas ? item.name : item)); }
    save() { this.stack.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); this.record('save', []); }
    restore() { Object.assign(this, this.stack.pop()); this.record('restore', []); }
    resetObservation() { this.drawImages = []; this.fills = []; this.signature = 0; }
  }

  class Canvas extends Element {
    constructor(id = '') {
      super('canvas', id);
      this.name = id || `offscreen-${canvases.length}`;
      this.width = 640;
      this.height = 360;
      this.context = new Context(this);
      canvases.push(this);
    }
    getContext(kind) { assert.equal(kind, '2d'); return this.context; }
    toBlob(callback, type) { this.blobType = type; callback(blobFailure ? null : { type }); }
  }

  class AudioParam {
    value = 0;
    targets = [];
    setTargetAtTime(value) { this.value = value; this.targets.push(value); }
    setValueAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
    exponentialRampToValueAtTime(value) { this.value = value; }
    cancelScheduledValues() {}
  }
  class AudioNode {
    gain = new AudioParam();
    frequency = new AudioParam();
    connect() {}
    disconnect() {}
    start() {}
    stop() {}
  }
  class AudioContext {
    constructor() {
      this.state = 'suspended';
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = new AudioNode();
      this.gains = [];
      this.resumeCalls = 0;
      audioContexts.push(this);
    }
    createGain() { const node = new AudioNode(); this.gains.push(node); return node; }
    createBuffer(channels, length) { return { getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { return new AudioNode(); }
    createBiquadFilter() { return new AudioNode(); }
    createOscillator() { return new AudioNode(); }
    resume() {
      this.resumeCalls++;
      return new Promise(resolve => {
        pendingResume = () => { this.state = 'running'; pendingResume = null; resolve(); };
      });
    }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }

  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const [, tag, attrs, id] = match;
    const element = tag.toLowerCase() === 'canvas' ? new Canvas(id) : new Element(tag, id);
    for (const attr of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(attr[1], attr[2]);
    elements.set(id, element);
  }
  const body = new Element('body');
  const header = new Element('header');
  const footer = new Element('footer');
  for (const element of elements.values()) element.parentElement = body;
  const querySelector = selector => selector === '.masthead' || selector === 'header' ? header :
    selector === '.scene-footer' || selector === 'footer' ? footer :
      selector === 'body' ? body : elements.get(selector.replace(/^#/, '')) || null;
  const document = Object.assign(new Events(), {
    body, hidden: false, activeElement: body,
    documentElement: { clientWidth: width, clientHeight: height },
    getElementById: id => elements.get(id),
    querySelector,
    createElement: tag => tag === 'canvas' ? new Canvas() : new Element(tag),
  });
  const media = Object.assign(new Events(), { matches: reducedMotion, media: '(prefers-reduced-motion: reduce)' });
  media.addListener = callback => media.addEventListener('change', callback);
  media.removeListener = callback => media.removeEventListener('change', callback);
  const requestAnimationFrame = callback => { const id = nextId++; frames.set(id, callback); return id; };
  const cancelAnimationFrame = id => frames.delete(id);
  const computedStyle = element => ({
    paddingLeft: `${padding}px`, paddingRight: `${padding}px`, paddingTop: `${padding}px`, paddingBottom: `${padding}px`,
    rowGap: '15px', gap: '15px', maxWidth: '1280px',
    getPropertyValue(property) { return this[property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] || ''; },
    ...element.style,
  });
  const window = Object.assign(new Events(), {
    innerWidth: width, innerHeight: height,
    matchMedia: () => media,
    requestAnimationFrame, cancelAnimationFrame,
    getComputedStyle: computedStyle, AudioContext,
    visualViewport: Object.assign(new Events(), { width, height }),
  });
  const context = vm.createContext({
    window, document, requestAnimationFrame, cancelAnimationFrame, getComputedStyle: computedStyle,
    performance: { now: () => now },
    setTimeout(callback, delay) { const id = nextId++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    URL: { createObjectURL: () => 'blob:campus-snapshot', revokeObjectURL: url => revokedUrls.push(url) },
    console,
  });
  vm.runInContext(source, context, { filename: 'index.html', timeout: 5000 });

  return {
    elements, canvases, downloads, audioContexts, revokedUrls, document, window,
    screen: elements.get('scene').context,
    get scheduledFrames() { return frames.size; },
    click(id) { return elements.get(id).click(); },
    key(key, target = body, extra = {}) {
      return document.emit('keydown', { key, target, altKey: false, ctrlKey: false, metaKey: false, repeat: false, ...extra });
    },
    editor(tag = 'div') { const element = new Element(tag); element.isContentEditable = tag === 'div'; return element; },
    frame(timestamp = now + 40) {
      now = timestamp;
      const ready = [...frames.values()]; frames.clear();
      for (const callback of ready) callback(timestamp);
    },
    motion(matches) { media.matches = matches; media.emit('change', { matches }); },
    visibility(hidden) { document.hidden = hidden; document.emit('visibilitychange'); },
    async finishAudioResume() { assert.ok(pendingResume, 'AudioContext.resume must be pending.'); pendingResume(); await Promise.resolve(); await Promise.resolve(); },
    failBlob() { blobFailure = true; },
    runTimers() { const ready = [...timers.values()]; timers.clear(); for (const { callback } of ready) callback(); },
  };
}

test('startup paints the scene and starts animation without starting audio', () => {
  const scene = createScene();
  assert.ok(scene.screen.count > 0);
  assert.equal(scene.scheduledFrames, 1);
  assert.equal(scene.elements.get('pauseLabel').textContent, 'PAUSE');
  assert.equal(scene.elements.get('pauseButton').getAttribute('aria-pressed'), 'false');
  assert.equal(scene.audioContexts.length, 0);
  const before = scene.screen.count;
  scene.frame(40); scene.frame(80);
  assert.ok(scene.screen.count > before, 'Playing frames repaint the scene.');
  assert.equal(scene.scheduledFrames, 1);
});

test('pause stops painting; time, rain, and gate controls update the frozen scene immediately', () => {
  const scene = createScene();
  scene.click('pauseButton');
  assert.equal(scene.elements.get('pauseLabel').textContent, 'PLAY');
  assert.equal(scene.elements.get('pauseButton').getAttribute('aria-pressed'), 'true');
  assert.equal(scene.scheduledFrames, 0);
  const stopped = scene.screen.count;
  scene.frame(100); scene.frame(200);
  assert.equal(scene.screen.count, stopped);

  scene.click('timeButton'); // DAY
  scene.screen.resetObservation();
  scene.click('timeButton'); // DUSK
  assert.equal(scene.elements.get('timeLabel').textContent, 'DUSK');
  const dusk = scene.canvases[2];
  assert.ok(scene.screen.drawImages.some(([image]) => image === dusk || image.context.drawImages.some(([layer]) => layer === dusk)), 'The dusk artwork must be visible immediately.');
  assert.equal(scene.scheduledFrames, 0);

  scene.screen.resetObservation();
  scene.click('rainButton');
  assert.equal(scene.elements.get('rainLabel').textContent, 'RAIN');
  assert.ok(scene.screen.fills.some(fill => fill.color === '#355069' && fill.alpha > 0), 'Rain overlay must appear immediately.');
  const rainySignature = scene.screen.signature;
  scene.screen.resetObservation();
  scene.click('gateButton');
  assert.equal(scene.elements.get('gateLabel').textContent, 'CLOSED');
  assert.notEqual(scene.screen.signature, rainySignature, 'Gate geometry must change in the frozen scene.');
  assert.equal(scene.scheduledFrames, 0);
  const updated = scene.screen.count;
  scene.frame(300); scene.frame(500);
  assert.equal(scene.screen.count, updated);

  scene.click('pauseButton');
  assert.equal(scene.scheduledFrames, 1);
  const resumed = scene.screen.count;
  scene.frame(600); scene.frame(640);
  assert.ok(scene.screen.count > resumed);
});

test('reduced-motion startup and preference changes stop animation scheduling', () => {
  const scene = createScene({ reducedMotion: true });
  assert.equal(scene.elements.get('pauseLabel').textContent, 'PLAY');
  assert.equal(scene.scheduledFrames, 0);
  const initialPaint = scene.screen.count;
  scene.frame(40); scene.frame(80);
  assert.equal(scene.screen.count, initialPaint);
  scene.click('gateButton');
  assert.equal(scene.elements.get('gateLabel').textContent, 'CLOSED');
  assert.ok(scene.screen.count > initialPaint);
  assert.equal(scene.scheduledFrames, 0);

  scene.click('pauseButton'); // Explicit playback remains possible.
  assert.equal(scene.scheduledFrames, 1);
  scene.motion(true);
  assert.equal(scene.elements.get('pauseLabel').textContent, 'PLAY');
  assert.equal(scene.scheduledFrames, 0);
  scene.motion(false);
  assert.equal(scene.scheduledFrames, 0, 'Disabling the preference should preserve the paused choice.');
});

test('keyboard shortcuts work and leave editable fields, modifiers, and button Space alone', () => {
  const scene = createScene();
  assert.equal(scene.key('4').defaultPrevented, true);
  assert.equal(scene.elements.get('speedValue').textContent, '4×');
  scene.key('t'); scene.key('w'); scene.key('g');
  assert.equal(scene.elements.get('timeLabel').textContent, 'DAY');
  assert.equal(scene.elements.get('rainLabel').textContent, 'RAIN');
  assert.equal(scene.elements.get('gateLabel').textContent, 'CLOSED');
  for (const target of ['input', 'textarea', 'select', 'div'].map(tag => scene.editor(tag))) {
    assert.equal(scene.key('t', target).defaultPrevented, false);
  }
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }]) scene.key('t', undefined, extra);
  assert.equal(scene.elements.get('timeLabel').textContent, 'DAY');
  const button = scene.elements.get('gateButton');
  assert.equal(scene.key(' ', button).defaultPrevented, false);
  assert.equal(scene.elements.get('pauseLabel').textContent, 'PAUSE');
  assert.equal(scene.key(' ').defaultPrevented, true);
  assert.equal(scene.elements.get('pauseLabel').textContent, 'PLAY');
});

test('about dialog blocks scene shortcuts and outside click closes it', () => {
  const scene = createScene();
  scene.click('aboutButton');
  const dialog = scene.elements.get('aboutDialog');
  assert.equal(dialog.open, true);
  scene.key('p'); scene.key('t'); scene.key('w'); scene.key('g'); scene.key('4');
  assert.equal(scene.elements.get('pauseLabel').textContent, 'PAUSE');
  assert.equal(scene.elements.get('timeLabel').textContent, 'AUTO');
  assert.equal(scene.elements.get('rainLabel').textContent, 'DRY');
  assert.equal(scene.elements.get('gateLabel').textContent, 'OPEN');
  assert.equal(scene.elements.get('speedValue').textContent, '1×');
  dialog.emit('click', { clientX: -1, clientY: -1 });
  assert.equal(dialog.open, false);
  scene.key('p');
  assert.equal(scene.elements.get('pauseLabel').textContent, 'PLAY');
});

test('sound waits for user activation, ignores concurrent resume clicks, and mutes in the background', async () => {
  const scene = createScene();
  scene.click('soundButton'); scene.click('soundButton');
  assert.equal(scene.audioContexts.length, 1);
  const audio = scene.audioContexts[0];
  assert.equal(audio.resumeCalls, 1);
  await scene.finishAudioResume();
  assert.equal(scene.elements.get('soundLabel').textContent, 'SOUND');
  scene.frame(40);
  const master = audio.gains[0].gain;
  assert.ok(master.value > 0);
  scene.visibility(true);
  assert.equal(scene.scheduledFrames, 0);
  assert.equal(master.value, 0);
  const hiddenPaint = scene.screen.count;
  scene.frame(80);
  assert.equal(scene.screen.count, hiddenPaint);
  scene.visibility(false);
  assert.equal(scene.scheduledFrames, 1);
  scene.frame(120);
  assert.ok(master.value > 0);
  scene.click('soundButton');
  await Promise.resolve();
  assert.equal(scene.elements.get('soundLabel').textContent, 'MUTED');
  scene.frame(160);
  assert.equal(master.value, 0);
});

test('snapshot download uses a crisp 1920×1080 PNG and reports encoding failures', () => {
  const scene = createScene({ reducedMotion: true });
  scene.click('captureButton');
  const snapshot = scene.canvases.at(-1);
  assert.equal(snapshot.width, 1920);
  assert.equal(snapshot.height, 1080);
  assert.equal(snapshot.context.imageSmoothingEnabled, false);
  assert.equal(snapshot.blobType, 'image/png');
  assert.equal(snapshot.context.drawImages[0][0], scene.elements.get('scene'));
  assert.equal(scene.downloads.length, 1);
  assert.equal(scene.downloads[0].download, 'SUST-pixels-day.png');
  scene.runTimers();
  assert.deepEqual(scene.revokedUrls, ['blob:campus-snapshot']);
  scene.failBlob(); scene.click('captureButton');
  assert.equal(scene.downloads.length, 1);
  assert.match(scene.elements.get('toast').textContent, /could not save/i);
});

test('the scene fits a narrow viewport and respects its available padded width', () => {
  for (const padding of [10, 30]) {
    const scene = createScene({ width: 320, height: 700, padding });
    const appWidth = parseFloat(scene.elements.get('app').style.width);
    assert.ok(appWidth > 0);
    assert.ok(appWidth <= 320 - padding * 2, `App width ${appWidth}px exceeds available ${320 - padding * 2}px.`);
  }
  assert.match(html, /role="group"\s+aria-label="Campus scene controls"/, 'Ordinary Tab navigation should use group semantics.');
});
