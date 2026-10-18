import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type pg from 'pg';
import { createCanvas, getLastSeq, insertStroke, listStrokes } from './db/canvases.js';
import { isDatabaseUp } from './db/pool.js';
import { isCanvasId, parseStroke } from './validation.js';

// A stroke at the point limit is ~400 KB of JSON; anything bigger is rejected
// while reading, before it is buffered in full.
const MAX_BODY_BYTES = 1024 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** 72 random bits, URL-safe: short enough to share, impossible to guess. */
function newCanvasId(): string {
  return randomBytes(9).toString('base64url');
}

async function health(pool: pg.Pool, res: ServerResponse): Promise<void> {
  const dbUp = await isDatabaseUp(pool);
  // 503 lets the platform see the instance as unhealthy while the database is down.
  sendJson(res, dbUp ? 200 : 503, {
    status: dbUp ? 'ok' : 'degraded',
    database: dbUp ? 'up' : 'down',
    uptime: process.uptime(),
  });
}

async function route(
  pool: pg.Pool,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    return health(pool, res);
  }

  if (pathname === '/api/canvases' && method === 'POST') {
    const id = newCanvasId();
    await createCanvas(pool, id);
    return sendJson(res, 201, { id });
  }

  const match = /^\/api\/canvases\/([^/]+)(\/strokes)?$/.exec(pathname);
  const canvasId = match?.[1];
  if (!match || canvasId === undefined) throw new HttpError(404, 'Not found');
  if (!isCanvasId(canvasId)) throw new HttpError(404, 'Canvas not found');

  if (!match[2] && method === 'GET') {
    // Two queries without a transaction: a stroke saved in between is either
    // included or not, both are valid snapshots.
    if ((await getLastSeq(pool, canvasId)) === null) throw new HttpError(404, 'Canvas not found');
    const strokes = await listStrokes(pool, canvasId);
    return sendJson(res, 200, { id: canvasId, strokes });
  }

  if (match[2] && method === 'POST') {
    const parsed = parseStroke(await readJson(req));
    if (!parsed.ok) throw new HttpError(400, parsed.error);

    const result = await insertStroke(pool, canvasId, parsed.value);
    if (result.status === 'canvas-not-found') throw new HttpError(404, 'Canvas not found');
    if (result.status === 'id-taken') throw new HttpError(409, 'Stroke id already in use');
    // 200 on a duplicate id: the client retried a stroke that was already saved.
    return sendJson(res, result.status === 'created' ? 201 : 200, {
      id: parsed.value.id,
      seq: result.seq,
    });
  }

  throw new HttpError(405, 'Method not allowed');
}

export async function handleApi(
  pool: pg.Pool,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  try {
    await route(pool, req, res, pathname);
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    console.error(`${req.method} ${pathname} failed:`, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
}
