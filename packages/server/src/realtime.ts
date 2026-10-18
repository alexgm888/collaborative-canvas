import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Peer, ServerMessage } from '@canvas/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { StrokeStore } from './db/canvases.js';
import {
  MAX_POINTS_PER_LIVE_MESSAGE,
  isCanvasId,
  parseCursor,
  parseProfile,
  parseStroke,
} from './validation.js';

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

// Cursors and strokes in progress are only worth sending while they are
// fresh. When a client already has this much waiting, they are skipped for it
// rather than queued behind saved strokes.
const MAX_BUFFERED_EPHEMERAL_BYTES = 256 * 1024;

// Clients throttle cursors and live strokes to 20 messages per second each.
// The server allows twice that, with room for bursts, and silently drops the
// rest: a misbehaving client cannot make the server flood the room.
const EPHEMERAL_RATE_PER_SECOND = 80;
const EPHEMERAL_BURST = 160;

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

/** Token bucket: `take()` succeeds at most `rate` times per second on average. */
class RateLimiter {
  private tokens: number;
  private last = performance.now();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  take(): boolean {
    const now = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

interface Connection {
  socket: WebSocket;
  canvasId: string;
  alive: boolean;
  /** False until the canvas is known to exist; only joined peers are visible. */
  joined: boolean;
  peer: Peer;
  limiter: RateLimiter;
}

type Sender = (socket: WebSocket, message: ServerMessage) => void;

const send: Sender = (socket, message) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return;
  }
  socket.send(JSON.stringify(message));
};

/** Like `send`, but a message that would wait behind a backlog is dropped. */
const sendEphemeral: Sender = (socket, message) => {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_EPHEMERAL_BYTES) return;
  socket.send(JSON.stringify(message));
};

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Accepts WebSocket connections at `/api/canvases/:id/ws` and keeps one room
 * per canvas. A stroke is saved first and then sent to everyone else in the
 * room, so nobody sees a stroke that a page reload would lose.
 *
 * Cursors and strokes in progress are ephemeral: they are relayed at once,
 * never saved, and dropped when a client sends too many or cannot keep up.
 */
export function attachRealtime(server: Server, store: StrokeStore): Realtime {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const rooms = new Map<string, Set<Connection>>();
  const connections = new Set<Connection>();

  function broadcast(from: Connection, message: ServerMessage, sendTo: Sender = send): void {
    for (const other of rooms.get(from.canvasId) ?? []) {
      if (other !== from) sendTo(other.socket, message);
    }
  }

  function join(conn: Connection): void {
    let room = rooms.get(conn.canvasId);
    if (!room) {
      room = new Set();
      rooms.set(conn.canvasId, room);
    }
    // Welcome and announce in the same tick as joining, so the newcomer knows
    // every peer before any message about one of them can reach it.
    send(conn.socket, { type: 'welcome', peers: [...room].map((other) => other.peer) });
    broadcast(conn, { type: 'peer-joined', peer: conn.peer });
    room.add(conn);
    conn.joined = true;
  }

  function leave(conn: Connection): void {
    connections.delete(conn);
    const room = rooms.get(conn.canvasId);
    if (!room?.delete(conn)) return;
    if (room.size === 0) rooms.delete(conn.canvasId);
    else broadcast(conn, { type: 'peer-left', peerId: conn.peer.id });
  }

  /** Relays a cursor or a stroke in progress. Invalid ones are dropped. */
  function handleEphemeral(conn: Connection, message: Record<string, unknown>): void {
    // Before joining nobody can see this peer; over the limit, the next
    // message carries the newer state anyway.
    if (!conn.joined || !conn.limiter.take()) return;

    if (message.type === 'cursor') {
      const position = parseCursor(message.position);
      if (!position.ok) return;
      conn.peer.cursor = position.value;
      broadcast(
        conn,
        { type: 'cursor', peerId: conn.peer.id, position: position.value },
        sendEphemeral,
      );
    } else {
      const stroke = parseStroke(message.stroke, MAX_POINTS_PER_LIVE_MESSAGE);
      if (!stroke.ok) return;
      broadcast(conn, { type: 'live', peerId: conn.peer.id, stroke: stroke.value }, sendEphemeral);
    }
  }

  async function handleStroke(conn: Connection, stroke: unknown): Promise<void> {
    const strokeId = (stroke as { id?: unknown } | undefined)?.id;
    const id = typeof strokeId === 'string' ? strokeId : null;

    const parsed = parseStroke(stroke);
    if (!parsed.ok) {
      send(conn.socket, { type: 'rejected', id, error: parsed.error });
      // Others may be showing it in progress. The cancel only ever applies to
      // this peer's own strokes, so an unchecked id is harmless.
      if (id !== null) {
        broadcast(conn, { type: 'live-cancel', peerId: conn.peer.id, id: id.toLowerCase() });
      }
      return;
    }

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

  function parseMessage(conn: Connection, data: RawData, isBinary: boolean) {
    let message: unknown;
    try {
      if (isBinary) throw new Error('binary');
      message = JSON.parse(data.toString());
    } catch {
      send(conn.socket, { type: 'rejected', id: null, error: 'messages must be JSON text' });
      return null;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      send(conn.socket, { type: 'rejected', id: null, error: 'messages must be JSON objects' });
      return null;
    }
    return message as Record<string, unknown>;
  }

  async function onConnection(
    socket: WebSocket,
    canvasId: string,
    profile: { name: string; color: string },
  ): Promise<void> {
    const conn: Connection = {
      socket,
      canvasId,
      alive: true,
      joined: false,
      peer: { id: randomUUID(), ...profile, cursor: null },
      limiter: new RateLimiter(EPHEMERAL_RATE_PER_SECOND, EPHEMERAL_BURST),
    };
    connections.add(conn);

    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('close', () => leave(conn));
    socket.on('error', (err) => console.error(`WebSocket error on ${canvasId}:`, err.message));

    // Strokes are handled one at a time, so a client's strokes are saved in
    // the order it drew them. Ephemeral messages skip that queue: a cursor must
    // not wait for a database write. A stroke's live points still reach others
    // before the stroke itself, which is only broadcast once saved.
    let queue = Promise.resolve();
    socket.on('message', (data, isBinary) => {
      const message = parseMessage(conn, data, isBinary);
      if (!message) return;
      if (message.type === 'cursor' || message.type === 'live') {
        handleEphemeral(conn, message);
        return;
      }
      if (message.type !== 'stroke') {
        send(socket, { type: 'rejected', id: null, error: 'unknown message type' });
        return;
      }
      queue = queue
        .then(() => handleStroke(conn, message.stroke))
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
      // Closed while waiting: `leave` already ran and would never run again.
      if (socket.readyState !== WebSocket.OPEN) return;
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
    const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');
    const canvasId = WS_PATH_RE.exec(pathname)?.[1];
    if (canvasId === undefined || !isCanvasId(canvasId)) {
      rejectUpgrade(socket, '404 Not Found');
      return;
    }
    const profile = parseProfile(searchParams);
    wss.handleUpgrade(req, socket, head, (ws) => void onConnection(ws, canvasId, profile));
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
