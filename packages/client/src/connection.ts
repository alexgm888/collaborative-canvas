import type { ClientMessage, Peer, Point, ServerMessage, Stroke } from '@canvas/shared';
import type { Identity } from './identity';
import { StrokeLog } from './strokeLog';

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'not-found';

export interface CanvasState {
  status: ConnectionStatus;
  /** False until the first snapshot arrives. */
  loaded: boolean;
  strokes: Stroke[];
  /** Own strokes the server has not confirmed yet. */
  pending: number;
  /** Own strokes the server refused; they stay on screen but are not saved. */
  rejected: number;
  /** Everyone else with the canvas open. Empty while offline. */
  peers: Peer[];
  /** Strokes others are drawing right now, not saved yet. */
  live: Stroke[];
  /** Whether there is an own stroke to hide, or a hidden one to show again. */
  canUndo: boolean;
  canRedo: boolean;
}

/** Saved operations waiting for an ack, resent on every (re)connection. */
type Durable = Extract<ClientMessage, { type: 'stroke' | 'visibility' }>;

// Backoff between reconnection attempts; the last value repeats. Each delay
// gets random jitter so clients dropped together do not return together.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10_000];

// Pointer events fire 60-240 times per second. Cursors and strokes in
// progress go out at most this often, carrying only the latest cursor and the
// points drawn since the previous message.
const EPHEMERAL_INTERVAL_MS = 50;

// The server refuses saved strokes above this; showing more of a peer's stroke
// in progress would only make it disappear when the final one is rejected.
const MAX_LIVE_POINTS = 10_000;

function socketUrl(canvasId: string, identity: Identity, since: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({
    name: identity.name,
    color: identity.color,
    user: identity.userId,
    since: String(since),
  });
  return `${protocol}//${window.location.host}/api/canvases/${encodeURIComponent(canvasId)}/ws?${query}`;
}

/**
 * Keeps a canvas in sync with the server over a WebSocket, reconnecting when
 * the connection drops.
 *
 * Own strokes are drawn at once and kept in an outbox until the server acks
 * them; every (re)connection resends the outbox. That is safe because the
 * server ignores a stroke id it already has. Each reconnection asks for the
 * strokes after the last seq this client has without gaps, so strokes drawn
 * by others while offline appear without downloading the whole canvas again.
 *
 * Undo and redo hide and show this tab's own strokes, newest first. They are
 * operations like strokes: applied at once, kept in the outbox until acked,
 * and seen by everyone. Others' strokes are never touched, so two people
 * undoing at the same time cannot get in each other's way.
 *
 * Cursors and strokes in progress are throttled and sent only while online;
 * losing one is harmless because the next carries newer state, and the final
 * stroke always replaces its live version.
 */
export class CanvasConnection {
  private state: CanvasState = {
    status: 'connecting',
    loaded: false,
    strokes: [],
    pending: 0,
    rejected: 0,
    peers: [],
    live: [],
    canUndo: false,
    canRedo: false,
  };
  private readonly listeners = new Set<() => void>();
  /** By the id of the stroke or change; a Map keeps the order they were made in. */
  private readonly outbox = new Map<string, Durable>();
  /** Own strokes that undo would hide, newest last. */
  private readonly undoStack: string[] = [];
  /** Own strokes that redo would show again, most recently hidden last. */
  private readonly redoStack: string[] = [];
  private readonly log = new StrokeLog();
  private readonly peers = new Map<string, Peer>();
  /** Strokes in progress by id, with the peer drawing each one. */
  private readonly live = new Map<string, { peerId: string; stroke: Stroke }>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  // Outgoing ephemeral state, flushed by `flushEphemeral`.
  private cursor: Point | null = null;
  private cursorDirty = false;
  private drawing: Stroke | null = null;
  private drawingSent = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = 0;

  constructor(
    private readonly canvasId: string,
    private readonly identity: Identity,
  ) {
    this.connect();
  }

  getState = (): CanvasState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Draws a finished stroke locally and sends it as soon as possible. */
  addStroke(stroke: Stroke): void {
    // Unsent live points are not needed: the final stroke has them all.
    if (this.drawing?.id === stroke.id) this.drawing = null;
    this.log.addLocal(stroke);
    this.undoStack.push(stroke.id);
    // A new stroke starts a new branch of history, as in any editor.
    this.redoStack.length = 0;
    this.enqueue(stroke.id, { type: 'stroke', stroke });
  }

  /** Hides the last own stroke that is still visible. */
  undo(): void {
    const strokeId = this.undoStack.pop();
    if (strokeId === undefined) return;
    this.redoStack.push(strokeId);
    this.changeVisibility(strokeId, false);
  }

  /** Shows again the last stroke that undo hid. */
  redo(): void {
    const strokeId = this.redoStack.pop();
    if (strokeId === undefined) return;
    this.undoStack.push(strokeId);
    this.changeVisibility(strokeId, true);
  }

  private changeVisibility(strokeId: string, visible: boolean): void {
    const change = { id: crypto.randomUUID(), strokeId, visible };
    this.log.addLocalChange(change);
    this.enqueue(change.id, { type: 'visibility', change });
  }

  private enqueue(id: string, message: Durable): void {
    this.outbox.set(id, message);
    this.update({ strokes: this.log.all() });
    this.send(message);
  }

  /** A stroke that can no longer be hidden or shown leaves the history. */
  private forget(strokeId: string): void {
    for (const stack of [this.undoStack, this.redoStack]) {
      const i = stack.indexOf(strokeId);
      if (i !== -1) stack.splice(i, 1);
    }
  }

  /**
   * Shares the stroke being drawn. Call it with the same object every time
   * points are added to it; only the new points are sent.
   */
  updateLiveStroke(stroke: Stroke): void {
    if (this.drawing?.id !== stroke.id) {
      this.drawing = stroke;
      this.drawingSent = 0;
    }
    this.scheduleFlush();
  }

  /** Shares the pointer position, or null when it leaves the canvas. */
  moveCursor(position: Point | null): void {
    this.cursor = position;
    this.cursorDirty = true;
    this.scheduleFlush();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.flushTimer);
    this.socket?.close(1000);
    this.socket = null;
  }

  private connect(): void {
    const socket = new WebSocket(socketUrl(this.canvasId, this.identity, this.log.lastSeq));
    this.socket = socket;
    this.update({ status: 'connecting' });

    socket.onopen = () => {
      // In the order they were made: an undo must not reach the server
      // before the stroke it hides.
      for (const message of this.outbox.values()) this.send(message);
    };
    socket.onmessage = (event) => {
      this.receive(JSON.parse(String(event.data)) as ServerMessage);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket || this.closed) return;
      this.socket = null;
      // Presence is only known while connected; the next welcome rebuilds it.
      this.peers.clear();
      this.live.clear();
      if (event.code === 4404) {
        this.update({ status: 'not-found' });
        return;
      }
      this.update({ status: 'offline' });
      this.scheduleReconnect();
    };
    // Errors are always followed by a close event, which does the handling.
  }

  private scheduleReconnect(): void {
    const base =
      RECONNECT_DELAYS_MS[Math.min(this.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 10_000;
    this.attempt++;
    const delay = base / 2 + Math.random() * base;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /**
   * Throttle with leading and trailing edges: the first change after a quiet
   * period goes out at once, later ones wait for the interval to end, and the
   * last state is never lost.
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    const wait = Math.max(0, this.lastFlush + EPHEMERAL_INTERVAL_MS - performance.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushEphemeral();
    }, wait);
  }

  private flushEphemeral(): void {
    this.lastFlush = performance.now();
    if (this.cursorDirty) {
      this.cursorDirty = false;
      this.send({ type: 'cursor', position: this.cursor });
    }
    const drawing = this.drawing;
    if (drawing && drawing.points.length > this.drawingSent) {
      const points = drawing.points.slice(this.drawingSent, MAX_LIVE_POINTS);
      this.drawingSent = drawing.points.length;
      if (points.length > 0) {
        this.send({ type: 'live', stroke: { ...drawing, points } });
      }
    }
  }

  private livePatch(): Partial<CanvasState> {
    return { live: [...this.live.values()].map((entry) => entry.stroke) };
  }

  private peersPatch(): Partial<CanvasState> {
    return { peers: [...this.peers.values()] };
  }

  private dropLiveOf(peerId: string): void {
    for (const [id, entry] of this.live) {
      if (entry.peerId === peerId) this.live.delete(id);
    }
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot':
        this.attempt = 0;
        // Strokes broadcast before the snapshot was read may be in both; the
        // log keeps one of each.
        this.log.applySnapshot(message.since, message.strokes, message.changes);
        // An own operation saved before the connection dropped, whose ack
        // never arrived. The resent copy will be acked anyway.
        for (const stroke of message.strokes) this.outbox.delete(stroke.id);
        for (const change of message.changes) this.outbox.delete(change.id);
        this.update({ status: 'online', loaded: true, strokes: this.log.all() });
        return;
      case 'stroke':
        if (!this.log.addSaved(message.stroke)) return;
        // Its live version goes away in the same update, so nothing flickers.
        this.live.delete(message.stroke.id);
        this.update({ strokes: this.log.all(), ...this.livePatch() });
        return;
      case 'visibility':
        if (this.log.addSavedChange(message.change)) this.update({ strokes: this.log.all() });
        return;
      case 'ack':
        this.outbox.delete(message.id);
        this.log.confirm(message.id, message.seq);
        this.update({ strokes: this.log.all() });
        return;
      case 'rejected': {
        console.error('Rejected by the server:', message.error);
        const refused = message.id === null ? undefined : this.outbox.get(message.id);
        if (!refused || message.id === null) return;
        this.outbox.delete(message.id);
        if (refused.type === 'stroke') {
          // It stays on screen, marked as not saved; there is nothing to undo.
          this.forget(refused.stroke.id);
          this.update({ rejected: this.state.rejected + 1 });
        } else {
          this.log.dropLocalChange(message.id);
          this.forget(refused.change.strokeId);
          this.update({ strokes: this.log.all() });
        }
        return;
      }
      case 'not-found':
        // The close event (4404) that follows sets the status.
        return;
      case 'welcome':
        this.peers.clear();
        for (const peer of message.peers) this.peers.set(peer.id, peer);
        this.update(this.peersPatch());
        return;
      case 'peer-joined':
        this.peers.set(message.peer.id, message.peer);
        this.update(this.peersPatch());
        return;
      case 'peer-left':
        this.peers.delete(message.peerId);
        this.dropLiveOf(message.peerId);
        this.update({ ...this.peersPatch(), ...this.livePatch() });
        return;
      case 'cursor': {
        const peer = this.peers.get(message.peerId);
        if (!peer) return;
        this.peers.set(peer.id, { ...peer, cursor: message.position });
        this.update(this.peersPatch());
        return;
      }
      case 'live': {
        const { peerId, stroke } = message;
        // Points that arrive after the final stroke would draw it twice.
        if (!this.peers.has(peerId) || this.log.has(stroke.id)) return;
        const entry = this.live.get(stroke.id);
        if (entry && entry.peerId !== peerId) return;
        const points = entry ? [...entry.stroke.points, ...stroke.points] : stroke.points;
        this.live.set(stroke.id, {
          peerId,
          stroke: { ...stroke, points: points.slice(0, MAX_LIVE_POINTS) },
        });
        this.update(this.livePatch());
        return;
      }
      case 'live-cancel':
        if (this.live.get(message.id)?.peerId !== message.peerId) return;
        this.live.delete(message.id);
        this.update(this.livePatch());
        return;
    }
  }

  private update(patch: Partial<CanvasState>): void {
    this.state = {
      ...this.state,
      ...patch,
      pending: this.outbox.size,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
    for (const listener of this.listeners) listener();
  }
}
