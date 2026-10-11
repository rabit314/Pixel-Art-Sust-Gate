# SUST — Campus in Pixels

An animated, hand-drawn pixel-art interpretation of the main entrance to Shahjalal University of Science and Technology in Sylhet, Bangladesh.

The complete artwork and application live in `index.html`. It uses Canvas 2D and optional Web Audio, with no external assets, tracking, dependencies, or build step. This is an artistic recreation, not an official university website.

## View locally

Open `index.html` in a modern browser, or use Node.js 18 or newer:

```sh
npm start
```

Then open <http://127.0.0.1:8080>.

## Controls

| Key | Action |
| --- | --- |
| P / Space | Pause or play |
| 1 / 2 / 4 | Set animation speed |
| T | Cycle Auto, Day, Dusk, Night, and Dawn |
| W | Cycle dry, rain, and automatic weather |
| G | Open or close the gates |
| M | Toggle ambient sound |
| S | Save a crisp 1920 × 1080 PNG snapshot |

The buttons work on touch screens, and clicking the entrance also toggles its gates. Tab navigates the controls. The information dialog documents the shortcuts and closes with Escape.

Sound starts only after a user action. Pausing or hiding the page mutes it and stops the animation loop. Reduced-motion preferences start the scene paused; time, weather, and gate changes apply immediately while paused. Press Play to opt into animation.

## Validation

```sh
npm test
```

The dependency-free Node tests execute the page's actual inline JavaScript with mocked browser APIs and check pause/resume, reduced motion, keyboard controls, visibility, sound, and snapshot behavior. Browser checks cover rendering and responsive layout separately.

## GitHub Pages

To publish this repository as a website, select **Settings → Pages → Deploy from a branch → main → / (root)**. `index.html` is already at the repository root. Uploading the source does not itself enable Pages.
