import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from './db/migrate.js';
import { createPool, isDatabaseUp } from './db/pool.js';

const PORT = Number(process.env.PORT ?? 3001);

// Locally it defaults to the database from docker-compose.yml; in production a
// missing DATABASE_URL is a configuration error, so fail at startup.
const DEV_DATABASE_URL = 'postgres://canvas:canvas@localhost:5432/canvas';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  (process.env.NODE_ENV === 'production' ? undefined : DEV_DATABASE_URL);

if (!DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = createPool(DATABASE_URL);

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

async function health(res: ServerResponse): Promise<void> {
  const dbUp = await isDatabaseUp(pool);
  // 503 lets the platform see the instance as unhealthy while the database is down.
  sendJson(res, dbUp ? 200 : 503, {
    status: dbUp ? 'ok' : 'degraded',
    database: dbUp ? 'up' : 'down',
    uptime: process.uptime(),
  });
}

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/api/health') {
    void health(res);
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

// Apply pending migrations before accepting traffic, so no request ever sees
// an outdated schema. If the database is unreachable the process exits and the
// platform restarts it.
try {
  await migrate(pool);
} catch (err) {
  console.error('Database migration failed:', err);
  await pool.end();
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

function shutdown(): void {
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
