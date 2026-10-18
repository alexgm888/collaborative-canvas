import { randomUUID } from 'node:crypto';
import type { ClientMessage, EphemeralMessage, Point, ServerMessage, Stroke } from '@canvas/shared';
import WebSocket from 'ws';
import { Histogram } from './histogram.js';
import type { HistogramData } from './histogram.js';

/** How a simulated person behaves. Defaults mimic the real client (connection.ts). */
export interface Behavior {
  /** Cursor messages per second; the real client sends up to 20. */
  cursorHz: number;
  /** Pause between strokes, in ms. */
  pauseMs: [number, number];
  /** How long drawing a stroke takes, in ms. */
  strokeMs: [number, number];
  /** Chance of undoing right after a stroke is saved. */
  undoRate: number;
}

// The real client flushes cursors and live points every 50 ms, and pointer
// events arrive at about 60 per second: 3 new points per flush.
export const TICK_MS = 50;
const POINTS_PER_TICK = 3;
const CANVAS = { width: 1600, height: 1000 };
const COLORS = ['#e11d48', '#d97706', '#059669', '#0891b2', '#2563eb', '#7c3aed'];

export const LATENCIES = [
  'join',
  'strokeAck',
  'strokeToOthers',
  'undoAck',
  'undoToOthers',
  'cursorToOthers',
  'liveToOthers',
] as const;
export type LatencyName = (typeof LATENCIES)[number];

/** Plain data of Metrics, to send it from a worker thread. */
export interface MetricsData {
  latency: Record<LatencyName, HistogramData>;
  sent: Record<string, number>;
  received: Record<string, number>;
  bytesOut: number;
  bytesIn: number;
  unexpectedCloses: number;
  livePointsReceived: number;
  errors: Record<string, number>;
}

/**
 * What the simulated clients of one thread measure.
 *
 * Latency is measured from send to receipt with one clock, so only between
 * clients of the same thread: each message is timed by the receivers that
 * share its sender's thread, a random sample of all of them.
 */
export class Metrics {
  readonly latency = Object.fromEntries(LATENCIES.map((name) => [name, new Histogram()])) as Record<
    LatencyName,
    Histogram
  >;
  readonly sent = new Map<string, number>();
  readonly received = new Map<string, number>();
  bytesOut = 0;
  bytesIn = 0;
  unexpectedCloses = 0;
  livePointsReceived = 0;
  readonly errors = new Map<string, number>();

  /** When each operation or ephemeral message of this thread was sent. */
  readonly sentAt = new Map<string, number>();

  count(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  /** Forgets send times nobody will look up anymore. */
  prune(olderThanMs: number): void {
    const limit = performance.now() - olderThanMs;
    for (const [key, at] of this.sentAt) {
      if (at >= limit) break; // Insertion order is send order.
      this.sentAt.delete(key);
    }
  }

  toData(): MetricsData {
    return {
      latency: Object.fromEntries(
        LATENCIES.map((name) => [name, this.latency[name].toData()]),
      ) as Record<LatencyName, HistogramData>,
      sent: Object.fromEntries(this.sent),
      received: Object.fromEntries(this.received),
      bytesOut: this.bytesOut,
      bytesIn: this.bytesIn,
      unexpectedCloses: this.unexpectedCloses,
      livePointsReceived: this.livePointsReceived,
      errors: Object.fromEntries(this.errors),
    };
  }
}

const between = ([min, max]: [number, number]) => min + Math.random() * (max - min);
// Never exactly on the edge: two cursors stuck in the same corner would share
// a position, and positions are how receivers find when a cursor was sent.
const clamp = (v: number, max: number) => Math.min(max - Math.random(), Math.max(Math.random(), v));
const pointKey = (p: Point) => `${p.x},${p.y}`;

/**
 * One simulated person with the canvas open: moves the pointer, draws,
 * sometimes undoes, and keeps every saved operation it learns about by seq so
 * the run can check that everyone ends with the same canvas.
 */
export class SimClient {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopping = false;
  private ticks = 0;

  /** Saved operations by seq: stroke or change id. */
  readonly ops = new Map<number, string>();
  /** Own strokes and changes sent and not acked yet, with when they were sent. */
  readonly pending = new Map<string, number>();
  /** Own saved strokes still visible, newest last. */
  private readonly visible: string[] = [];
  /** Ids of own changes not acked yet. */
  private readonly ownChanges = new Set<string>();
  /** Ephemeral messages sent, to know how many deliveries the room should get. */
  readonly ephemeralSent = { cursor: 0, livePoints: 0 };
  /** Peer id of this connection, to skip its own messages in batches. */
  private self: string | null = null;

  private cursor: Point = { x: Math.random() * CANVAS.width, y: Math.random() * CANVAS.height };
  private drawing: { stroke: Stroke; sent: number; endsAt: number } | null = null;
  private nextStrokeAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly canvasId: string,
    private readonly name: string,
    private readonly metrics: Metrics,
    private readonly behavior: Behavior,
    readonly userId = randomUUID(),
  ) {}

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** Opens the socket; resolves once the snapshot is in. */
  connect(timeoutMs = 15_000): Promise<void> {
    const url = new URL(`/api/canvases/${this.canvasId}/ws`, this.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = new URLSearchParams({
      name: this.name,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
      user: this.userId,
      since: '0',
    }).toString();

    const started = performance.now();
    const socket = new WebSocket(url);
    this.socket = socket;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('no snapshot in time'));
        socket.terminate();
      }, timeoutMs);
      socket.on('message', (data) => {
        const text = String(data);
        this.metrics.bytesIn += text.length;
        const message = JSON.parse(text) as ServerMessage;
        if (message.type === 'snapshot') {
          clearTimeout(timeout);
          this.metrics.latency.join.record(performance.now() - started);
          resolve();
        }
        this.receive(message);
      });
      socket.on('error', (err) => {
        this.metrics.count(this.metrics.errors, `socket: ${err.message}`);
      });
      socket.on('close', (code) => {
        clearTimeout(timeout);
        clearInterval(this.timer);
        if (!this.stopping) {
          this.metrics.unexpectedCloses++;
          this.metrics.count(this.metrics.errors, `closed with ${code}`);
        }
        reject(new Error(`closed with ${code}`));
      });
    });
  }

  /** Starts moving and drawing, out of step with the other clients. */
  start(): void {
    this.nextStrokeAt = performance.now() + between(this.behavior.pauseMs);
    setTimeout(() => {
      if (this.stopping) return;
      this.timer = setInterval(() => this.tick(), TICK_MS);
    }, Math.random() * TICK_MS);
  }

  /** Stops making new operations; what is in flight still gets acked. */
  stopActivity(): void {
    this.stopping = true;
    clearInterval(this.timer);
  }

  close(): void {
    this.stopping = true;
    clearInterval(this.timer);
    this.socket?.close(1000);
  }

  private send(message: ClientMessage): void {
    if (!this.isOpen) return;
    const text = JSON.stringify(message);
    this.metrics.bytesOut += text.length;
    this.metrics.count(this.metrics.sent, message.type);
    if (message.type === 'cursor') this.ephemeralSent.cursor++;
    if (message.type === 'live') this.ephemeralSent.livePoints += message.stroke.points.length;
    this.socket!.send(text);
  }

  private tick(): void {
    this.ticks++;
    const now = performance.now();
    const m = this.metrics;

    // A wandering pointer; every position is a new random double, so it
    // doubles as the key receivers look its send time up by.
    this.cursor = {
      x: clamp(this.cursor.x + (Math.random() - 0.5) * 40, CANVAS.width),
      y: clamp(this.cursor.y + (Math.random() - 0.5) * 40, CANVAS.height),
    };
    const cursorEvery = Math.max(1, Math.round(1000 / TICK_MS / this.behavior.cursorHz));
    if (this.behavior.cursorHz > 0 && this.ticks % cursorEvery === 0) {
      m.sentAt.set(`c:${pointKey(this.cursor)}`, now);
      this.send({ type: 'cursor', position: this.cursor });
    }

    if (!this.drawing && now >= this.nextStrokeAt) {
      this.drawing = {
        stroke: {
          id: randomUUID(),
          color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
          width: 2 + Math.floor(Math.random() * 10),
          points: [],
        },
        sent: 0,
        endsAt: now + between(this.behavior.strokeMs),
      };
    }
    const drawing = this.drawing;
    if (!drawing) return;

    for (let i = 0; i < POINTS_PER_TICK; i++) {
      drawing.stroke.points.push({
        x: clamp(this.cursor.x + (Math.random() - 0.5) * 6, CANVAS.width),
        y: clamp(this.cursor.y + (Math.random() - 0.5) * 6, CANVAS.height),
      });
    }

    if (now < drawing.endsAt) {
      const points = drawing.stroke.points.slice(drawing.sent);
      drawing.sent = drawing.stroke.points.length;
      m.sentAt.set(`l:${pointKey(points[0]!)}`, now);
      this.send({ type: 'live', stroke: { ...drawing.stroke, points } });
      return;
    }

    // Finished: the final stroke replaces the live one everywhere.
    this.drawing = null;
    this.nextStrokeAt = now + between(this.behavior.pauseMs);
    this.pending.set(drawing.stroke.id, now);
    m.sentAt.set(drawing.stroke.id, now);
    this.send({ type: 'stroke', stroke: drawing.stroke });
  }

  private undo(): void {
    const strokeId = this.visible.pop();
    if (strokeId === undefined) return;
    const change = { id: randomUUID(), strokeId, visible: false };
    const now = performance.now();
    this.pending.set(change.id, now);
    this.ownChanges.add(change.id);
    this.metrics.sentAt.set(change.id, now);
    this.send({ type: 'visibility', change });
  }

  private receive(message: ServerMessage): void {
    const m = this.metrics;
    m.count(m.received, message.type);
    const now = performance.now();
    const record = (name: LatencyName, key: string) => {
      const at = m.sentAt.get(key);
      if (at !== undefined) m.latency[name].record(now - at);
    };

    switch (message.type) {
      case 'snapshot':
        for (const s of message.strokes) this.ops.set(s.seq, s.id);
        for (const c of message.changes) this.ops.set(c.seq, c.id);
        return;
      case 'ack': {
        const sentAt = this.pending.get(message.id);
        if (sentAt === undefined) return;
        this.pending.delete(message.id);
        this.ops.set(message.seq, message.id);
        // Strokes and changes share acks; tell them apart by what was sent.
        if (this.ownChanges.delete(message.id)) {
          m.latency.undoAck.record(now - sentAt);
        } else {
          m.latency.strokeAck.record(now - sentAt);
          this.visible.push(message.id);
          if (!this.stopping && Math.random() < this.behavior.undoRate) this.undo();
        }
        return;
      }
      case 'stroke':
        this.ops.set(message.stroke.seq, message.stroke.id);
        record('strokeToOthers', message.stroke.id);
        return;
      case 'visibility':
        this.ops.set(message.change.seq, message.change.id);
        record('undoToOthers', message.change.id);
        return;
      case 'welcome':
        // Absent before week 7; own messages never came back then.
        this.self = message.you ?? null;
        return;
      case 'batch':
        for (const ephemeral of message.messages) {
          if (ephemeral.peerId !== this.self) this.receiveEphemeral(ephemeral, record);
        }
        return;
      case 'rejected':
        m.count(m.errors, `rejected: ${message.error}`);
        if (message.id) this.pending.delete(message.id);
        return;
      default: {
        // Servers before batching (week 6) relayed each one on its own, only
        // to others; kept to measure them for comparison.
        const legacy = message as unknown as EphemeralMessage;
        if (legacy.type === 'cursor' || legacy.type === 'live')
          this.receiveEphemeral(legacy, record);
        return;
      }
    }
  }

  private receiveEphemeral(
    ephemeral: EphemeralMessage,
    record: (name: LatencyName, key: string) => void,
  ): void {
    const m = this.metrics;
    if (ephemeral.type === 'cursor') {
      m.count(m.received, 'batch.cursor');
      if (ephemeral.position) record('cursorToOthers', `c:${pointKey(ephemeral.position)}`);
      return;
    }
    // Chunks of one stroke may be merged; its points are never dropped.
    m.count(m.received, 'batch.live');
    m.livePointsReceived += ephemeral.stroke.points.length;
    const first = ephemeral.stroke.points[0];
    if (first) record('liveToOthers', `l:${pointKey(first)}`);
  }
}
