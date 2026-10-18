import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ServerMessage } from '@canvas/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { StrokeStore } from './db/canvases.js';
import { isCanvasId, parseStroke } from './validation.js';

const WS_PATH_RE = /^\/api\/canvases\/([^/]+)\/ws$/;

// Same limit as an HTTP request body: a stroke at the point limit fits.
const MAX_MESSAGE_BYTES = 1024 * 1024;

// Proxies (Railway's included) drop connections that stay silent for about a
// minute, and a client that vanishes without closing is only noticed when a
// ping goes unanswered.
const HEARTBEAT_INTERVAL_MS = 30_000;

// A client that cannot keep up would make the server buffer every stroke for
// it. Past this point it is disconnected; it reconnects and gets a snapshot.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

// Close codes. 4000-4999 are free for applications.
const CLOSE_GOING_AWAY = 1001;
const CLOSE_INTERNAL_ERROR = 1011;
const CLOSE_CANVAS_NOT_FOUND = 4404;

export interface Realtime {
  /** Number of open connections per canvas, for tests and diagnostics. */
  roomSizes(): Map<string, number>;
  /** Closes every connection and stops accepting new ones. */
  close(): Promise<void>;
}

interface Connection {
  socket: WebSocket;
  canvasId: string;
  alive: boolean;
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return;
  }
  socket.send(JSON.stringify(message));
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Accepts WebSocket connections at `/api/canvases/:id/ws` and keeps one room
 * per canvas. A stroke is saved first and then sent to everyone else in the
 * room, so nobody sees a stroke that a page reload would lose.
 */
export function attachRealtime(server: Server, store: StrokeStore): Realtime {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const rooms = new Map<string, Set<Connection>>();
  const connections = new Set<Connection>();

  function join(conn: Connection): void {
    let room = rooms.get(conn.canvasId);
    if (!room) {
      room = new Set();
      rooms.set(conn.canvasId, room);
    }
    room.add(conn);
  }

  function leave(conn: Connection): void {
    connections.delete(conn);
    const room = rooms.get(conn.canvasId);
    if (!room) return;
    room.delete(conn);
    if (room.size === 0) rooms.delete(conn.canvasId);
  }

  function broadcast(from: Connection, message: ServerMessage): void {
    for (const other of rooms.get(from.canvasId) ?? []) {
      if (other !== from) send(other.socket, message);
    }
  }

  async function handleMessage(conn: Connection, data: RawData, isBinary: boolean): Promise<void> {
    let message: unknown;
    try {
      if (isBinary) throw new Error('binary');
      message = JSON.parse(data.toString());
    } catch {
      return send(conn.socket, { type: 'rejected', id: null, error: 'messages must be JSON text' });
    }

    const { type, stroke } = (message ?? {}) as { type?: unknown; stroke?: unknown };
    const strokeId = (stroke as { id?: unknown } | undefined)?.id;
    const id = typeof strokeId === 'string' ? strokeId : null;

    if (type !== 'stroke') {
      return send(conn.socket, { type: 'rejected', id: null, error: 'unknown message type' });
    }
    const parsed = parseStroke(stroke);
    if (!parsed.ok) return send(conn.socket, { type: 'rejected', id, error: parsed.error });

    const result = await store.insertStroke(conn.canvasId, parsed.value);
    if (result === 'canvas-not-found') {
      send(conn.socket, { type: 'not-found' });
      conn.socket.close(CLOSE_CANVAS_NOT_FOUND, 'Canvas not found');
      return;
    }
    // A duplicate was already broadcast when it was first saved.
    if (result === 'created') broadcast(conn, { type: 'stroke', stroke: parsed.value });
    send(conn.socket, { type: 'ack', id: parsed.value.id });
  }

  async function onConnection(socket: WebSocket, canvasId: string): Promise<void> {
    const conn: Connection = { socket, canvasId, alive: true };
    connections.add(conn);

    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('close', () => leave(conn));
    socket.on('error', (err) => console.error(`WebSocket error on ${canvasId}:`, err.message));

    // Messages are handled one at a time, so a client's strokes are saved in
    // the order it drew them.
    let queue = Promise.resolve();
    socket.on('message', (data, isBinary) => {
      queue = queue
        .then(() => handleMessage(conn, data, isBinary))
        .catch((err: unknown) => {
          console.error(`Message on ${canvasId} failed:`, err);
          // The client keeps unacknowledged strokes and resends them when it
          // reconnects, so closing is how a transient failure gets retried.
          socket.close(CLOSE_INTERNAL_ERROR, 'Internal error');
        });
    });

    try {
      if (!(await store.canvasExists(canvasId))) {
        send(socket, { type: 'not-found' });
        socket.close(CLOSE_CANVAS_NOT_FOUND, 'Canvas not found');
        return;
      }
      // Join before reading, so a stroke saved meanwhile is either in the
      // snapshot or broadcast to us (maybe both; the client merges by id).
      join(conn);
      const strokes = await store.listStrokes(canvasId);
      send(socket, { type: 'snapshot', strokes });
    } catch (err) {
      console.error(`Joining ${canvasId} failed:`, err);
      socket.close(CLOSE_INTERNAL_ERROR, 'Internal error');
    }
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const canvasId = WS_PATH_RE.exec(pathname)?.[1];
    if (canvasId === undefined || !isCanvasId(canvasId)) {
      rejectUpgrade(socket, '404 Not Found');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, canvasId));
  });

  const heartbeat = setInterval(() => {
    for (const conn of connections) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return {
    roomSizes: () => new Map([...rooms].map(([id, room]) => [id, room.size])),

    close: async () => {
      clearInterval(heartbeat);
      // 1001 tells clients to reconnect, which during a deploy lands them on
      // the new instance.
      for (const conn of connections) conn.socket.close(CLOSE_GOING_AWAY, 'Server shutting down');
      // Give the close handshake a moment, then drop whoever did not answer.
      if (connections.size > 0) await new Promise((resolve) => setTimeout(resolve, 1000).unref());
      for (const conn of connections) conn.socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
