import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { EphemeralMessage, Peer, Point, ServerMessage, Stroke } from '@canvas/shared';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { StrokeStore } from './db/canvases.js';
import {
  MAX_POINTS_PER_LIVE_MESSAGE,
  isCanvasId,
  parseCursor,
  parseProfile,
  parseSince,
  parseStroke,
  parseUserId,
  parseVisibility,
} from './validation.js';

const WS_PATH_RE = /^\/api\/canvases\/([^/]+)\/ws$/;

// Same limit as an HTTP request body: a stroke at the point limit fits.
const MAX_MESSAGE_BYTES = 1024 * 1024;

// Proxies (Railway's included) drop connections that stay silent for about a
// minute, and a client that vanishes without closing is only noticed when a
// ping goes unanswered.
const HEARTBEAT_INTERVAL_MS = 30_000;

// A client that cannot keep up would make the server buffer every stroke for
// it. Past this point it is disconnected; it reconnects and catches up from
// the last stroke it has.
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

// Relaying every cursor to everyone makes sends grow with the square of the
// room: 50 people sending 27 messages per second is 66 000 sends per second,
// which saturated the server in the load test. Instead, each room gathers its
// cursors and live points and sends them as one message this often, the same
// interval clients already throttle to.
const EPHEMERAL_FLUSH_MS = 50;

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
  /**
   * Operations of others saved before this connection's snapshot was sent;
   * null once it was. They go out right after the snapshot, so a client never
   * gets an operation before the snapshot it builds on.
   */
  backlog: ServerMessage[] | null;
  peer: Peer;
  /** Who may undo the strokes saved through this connection; null is nobody. */
  userId: string | null;
  limiter: RateLimiter;
}

/** Cursors and live points of a room waiting for the next batch. */
interface PendingBatch {
  /** Latest position of each peer that moved, by peer id. */
  cursors: Map<string, Point | null>;
  /** New points of each stroke in progress, by stroke id. */
  live: Map<string, { peerId: string; stroke: Stroke }>;
  timer: ReturnType<typeof setTimeout>;
}

/** Sends an already serialized message, so a broadcast serializes once. */
function sendData(socket: WebSocket, data: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.terminate();
    return;
  }
  socket.send(data);
}

function send(socket: WebSocket, message: ServerMessage): void {
  sendData(socket, JSON.stringify(message));
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Accepts WebSocket connections at `/api/canvases/:id/ws` and keeps one room
 * per canvas. A stroke is saved first and then sent to everyone else in the
 * room, so nobody sees a stroke that a page reload would lose.
 *
 * Every saved stroke carries its seq in the canvas. A client that reconnects
 * says up to which seq it has everything and gets only the strokes after it.
 * Undo and redo are saved operations too (visibility changes), numbered in the
 * same seq, and only the author of a stroke can make them.
 *
 * Cursors and strokes in progress are ephemeral: never saved, gathered per
 * room into one batch every 50 ms, and dropped when a client sends too many or
 * cannot keep up.
 */
export function attachRealtime(server: Server, store: StrokeStore): Realtime {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  const rooms = new Map<string, Set<Connection>>();
  const batches = new Map<string, PendingBatch>();
  const connections = new Set<Connection>();

  function batchOf(canvasId: string): PendingBatch {
    let batch = batches.get(canvasId);
    if (!batch) {
      batch = {
        cursors: new Map(),
        live: new Map(),
        timer: setTimeout(() => flushBatch(canvasId), EPHEMERAL_FLUSH_MS),
      };
      batches.set(canvasId, batch);
    }
    return batch;
  }

  /**
   * Sends the pending cursors and live points of a room to everyone in it,
   * serialized once. The sender's own are included: excluding them would mean
   * one serialization per person, and clients skip them by id.
   */
  function flushBatch(canvasId: string): void {
    const batch = batches.get(canvasId);
    if (!batch) return;
    clearTimeout(batch.timer);
    batches.delete(canvasId);

    const messages: EphemeralMessage[] = [];
    for (const { peerId, stroke } of batch.live.values()) {
      messages.push({ type: 'live', peerId, stroke });
    }
    for (const [peerId, position] of batch.cursors) {
      messages.push({ type: 'cursor', peerId, position });
    }
    const data = JSON.stringify({ type: 'batch', messages } satisfies ServerMessage);
    for (const conn of rooms.get(canvasId) ?? []) {
      const { socket } = conn;
      // Stale before it arrives for a client with this much waiting.
      if (socket.readyState !== WebSocket.OPEN) continue;
      if (socket.bufferedAmount > MAX_BUFFERED_EPHEMERAL_BYTES) continue;
      socket.send(data);
    }
  }

  function broadcast(from: Connection, message: ServerMessage): void {
    // Whatever was batched before this message is sent before it, so nobody
    // gets live points of a stroke after its cancel.
    flushBatch(from.canvasId);
    const data = JSON.stringify(message);
    for (const other of rooms.get(from.canvasId) ?? []) {
      if (other !== from) sendData(other.socket, data);
    }
  }

  /** Broadcasts a saved operation, holding it for whoever still waits for a snapshot. */
  function broadcastSaved(from: Connection, message: ServerMessage): void {
    flushBatch(from.canvasId);
    const data = JSON.stringify(message);
    for (const other of rooms.get(from.canvasId) ?? []) {
      if (other === from) continue;
      if (other.backlog) other.backlog.push(message);
      else sendData(other.socket, data);
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
    send(conn.socket, {
      type: 'welcome',
      you: conn.peer.id,
      peers: [...room].map((other) => other.peer),
    });
    broadcast(conn, { type: 'peer-joined', peer: conn.peer });
    room.add(conn);
    conn.joined = true;
  }

  function leave(conn: Connection): void {
    connections.delete(conn);
    const room = rooms.get(conn.canvasId);
    if (!room?.delete(conn)) return;
    if (room.size === 0) {
      rooms.delete(conn.canvasId);
      clearTimeout(batches.get(conn.canvasId)?.timer);
      batches.delete(conn.canvasId);
    } else {
      broadcast(conn, { type: 'peer-left', peerId: conn.peer.id });
    }
  }

  /** Adds a cursor or a stroke in progress to the next batch. Invalid ones are dropped. */
  function handleEphemeral(conn: Connection, message: Record<string, unknown>): void {
    // Before joining nobody can see this peer; over the limit, the next
    // message carries the newer state anyway.
    if (!conn.joined || !conn.limiter.take()) return;

    if (message.type === 'cursor') {
      const position = parseCursor(message.position);
      if (!position.ok) return;
      conn.peer.cursor = position.value;
      // Only where it is now matters, not where it went in between.
      batchOf(conn.canvasId).cursors.set(conn.peer.id, position.value);
    } else {
      const parsed = parseStroke(message.stroke, MAX_POINTS_PER_LIVE_MESSAGE);
      if (!parsed.ok) return;
      const stroke = parsed.value;
      const live = batchOf(conn.canvasId).live;
      const pending = live.get(stroke.id);
      // Every point counts: they are appended to what was drawn so far. An id
      // already used by someone else is not this peer's to extend.
      if (!pending) live.set(stroke.id, { peerId: conn.peer.id, stroke });
      else if (pending.peerId === conn.peer.id) pending.stroke.points.push(...stroke.points);
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

    const result = await store.insertStroke(conn.canvasId, parsed.value, conn.userId);
    switch (result.status) {
      case 'canvas-not-found':
        send(conn.socket, { type: 'not-found' });
        conn.socket.close(CLOSE_CANVAS_NOT_FOUND, 'Canvas not found');
        return;
      case 'id-taken':
        send(conn.socket, { type: 'rejected', id: parsed.value.id, error: 'stroke id in use' });
        broadcast(conn, { type: 'live-cancel', peerId: conn.peer.id, id: parsed.value.id });
        return;
      case 'created':
        broadcastSaved(conn, { type: 'stroke', stroke: { ...parsed.value, seq: result.seq } });
        break;
      case 'duplicate':
        // Already broadcast when it was first saved.
        break;
    }
    send(conn.socket, { type: 'ack', id: parsed.value.id, seq: result.seq });
  }

  /** An undo or redo: saved only if this connection's user drew the stroke. */
  async function handleChange(conn: Connection, change: unknown): Promise<void> {
    const changeId = (change as { id?: unknown } | undefined)?.id;
    const parsed = parseVisibility(change);
    if (!parsed.ok) {
      send(conn.socket, {
        type: 'rejected',
        id: typeof changeId === 'string' ? changeId : null,
        error: parsed.error,
      });
      return;
    }
    const { id } = parsed.value;
    if (conn.userId === null) {
      send(conn.socket, { type: 'rejected', id, error: 'only the author can undo a stroke' });
      return;
    }

    const result = await store.insertChange(conn.canvasId, conn.userId, parsed.value);
    switch (result.status) {
      case 'canvas-not-found':
        send(conn.socket, { type: 'not-found' });
        conn.socket.close(CLOSE_CANVAS_NOT_FOUND, 'Canvas not found');
        return;
      case 'id-taken':
        send(conn.socket, { type: 'rejected', id, error: 'change id in use' });
        return;
      case 'stroke-not-found':
        send(conn.socket, { type: 'rejected', id, error: 'stroke not found' });
        return;
      case 'not-author':
        send(conn.socket, { type: 'rejected', id, error: 'only the author can undo a stroke' });
        return;
      case 'created':
        broadcastSaved(conn, { type: 'visibility', change: { ...parsed.value, seq: result.seq } });
        break;
      case 'duplicate':
        break;
    }
    send(conn.socket, { type: 'ack', id, seq: result.seq });
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
    userId: string | null,
    since: number,
  ): Promise<void> {
    const conn: Connection = {
      socket,
      canvasId,
      alive: true,
      joined: false,
      backlog: [],
      peer: { id: randomUUID(), ...profile, cursor: null },
      userId,
      limiter: new RateLimiter(EPHEMERAL_RATE_PER_SECOND, EPHEMERAL_BURST),
    };
    connections.add(conn);

    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('close', () => leave(conn));
    socket.on('error', (err) => console.error(`WebSocket error on ${canvasId}:`, err.message));

    // Strokes and changes are handled one at a time, so a client's operations
    // are saved in the order it made them: an undo never overtakes its stroke. Ephemeral messages skip that queue: a cursor must
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
      if (message.type !== 'stroke' && message.type !== 'visibility') {
        send(socket, { type: 'rejected', id: null, error: 'unknown message type' });
        return;
      }
      queue = queue
        .then(() =>
          message.type === 'stroke'
            ? handleStroke(conn, message.stroke)
            : handleChange(conn, message.change),
        )
        .catch((err: unknown) => {
          console.error(`Message on ${canvasId} failed:`, err);
          // The client keeps unacknowledged strokes and resends them when it
          // reconnects, so closing is how a transient failure gets retried.
          socket.close(CLOSE_INTERNAL_ERROR, 'Internal error');
        });
    });

    try {
      const lastSeq = await store.getLastSeq(canvasId);
      if (lastSeq === null) {
        send(socket, { type: 'not-found' });
        socket.close(CLOSE_CANVAS_NOT_FOUND, 'Canvas not found');
        return;
      }
      // Closed while waiting: `leave` already ran and would never run again.
      if (socket.readyState !== WebSocket.OPEN) return;
      // Join before reading, so an operation saved meanwhile is either in the
      // snapshot or in the backlog (maybe both; the client merges by id).
      join(conn);
      // Seqs only grow, so a client ahead of the canvas got them from
      // somewhere else (a restored database, a bug). Its strokes cannot be
      // trusted: it gets everything and replaces what it has.
      const from = since <= lastSeq ? since : 0;
      const [strokes, changes] = await Promise.all([
        store.listStrokes(canvasId, from),
        store.listChanges(canvasId, from),
      ]);
      send(socket, { type: 'snapshot', since: from, strokes, changes });
      const backlog = conn.backlog ?? [];
      conn.backlog = null;
      for (const message of backlog) send(socket, message);
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
    const userId = parseUserId(searchParams.get('user'));
    const since = parseSince(searchParams.get('since'));
    wss.handleUpgrade(
      req,
      socket,
      head,
      (ws) => void onConnection(ws, canvasId, profile, userId, since),
    );
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
      for (const batch of batches.values()) clearTimeout(batch.timer);
      batches.clear();
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
