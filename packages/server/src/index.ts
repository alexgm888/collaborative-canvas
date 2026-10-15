import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 3001);

// In production the server also serves the built client, so a single container
// is enough to deploy the whole app.
const here = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIR = resolve(process.env.CLIENT_DIR ?? join(here, '../../client/dist'));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const requested = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(CLIENT_DIR, requested);

  // Guard against path traversal and fall back to index.html (SPA routing).
  if (!filePath.startsWith(CLIENT_DIR) || !existsSync(filePath) || extname(filePath) === '') {
    filePath = join(CLIENT_DIR, 'index.html');
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/api/health') {
    sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (!existsSync(CLIENT_DIR)) {
    sendJson(res, 200, { message: 'Client build not found. Run `npm run build` first.' });
    return;
  }

  void serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
