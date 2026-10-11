import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const page = new URL('../index.html', import.meta.url);
const port = Number(process.env.PORT || 8080);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  if (pathname !== '/' && pathname !== '/index.html') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }
  try {
    const html = await readFile(page);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : html);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Could not read index.html');
  }
});

server.on('error', error => {
  console.error(`Could not start preview: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => console.log(`SUST preview: http://127.0.0.1:${port}`));
