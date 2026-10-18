import type { ClientMessage, ServerMessage, Stroke } from '@canvas/shared';

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
}

// Backoff between reconnection attempts; the last value repeats. Each delay
// gets random jitter so clients dropped together do not return together.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10_000];

function socketUrl(canvasId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/canvases/${encodeURIComponent(canvasId)}/ws`;
}

/**
 * Keeps a canvas in sync with the server over a WebSocket, reconnecting when
 * the connection drops.
 *
 * Own strokes are drawn at once and kept in an outbox until the server acks
 * them; every (re)connection resends the outbox. That is safe because the
 * server ignores a stroke id it already has. On each connection the server
 * sends a full snapshot, which is merged by id with what is on screen, so
 * strokes drawn by others while offline appear after reconnecting.
 */
export class CanvasConnection {
  private state: CanvasState = {
    status: 'connecting',
    loaded: false,
    strokes: [],
    pending: 0,
    rejected: 0,
  };
  private readonly listeners = new Set<() => void>();
  private readonly outbox = new Map<string, Stroke>();
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private closed = false;

  constructor(private readonly canvasId: string) {
    this.connect();
  }

  getState = (): CanvasState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Draws a finished stroke locally and sends it as soon as possible. */
  addStroke(stroke: Stroke): void {
    this.outbox.set(stroke.id, stroke);
    this.update({ strokes: [...this.state.strokes, stroke] });
    this.send({ type: 'stroke', stroke });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000);
    this.socket = null;
  }

  private connect(): void {
    const socket = new WebSocket(socketUrl(this.canvasId));
    this.socket = socket;
    this.update({ status: 'connecting' });

    socket.onopen = () => {
      for (const stroke of this.outbox.values()) this.send({ type: 'stroke', stroke });
    };
    socket.onmessage = (event) => {
      this.receive(JSON.parse(String(event.data)) as ServerMessage);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket || this.closed) return;
      this.socket = null;
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

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case 'snapshot': {
        this.attempt = 0;
        // Server order first, then whatever is only known here: own strokes
        // not saved yet and strokes broadcast before the snapshot was read.
        const ids = new Set(message.strokes.map((s) => s.id));
        const localOnly = this.state.strokes.filter((s) => !ids.has(s.id));
        this.update({
          status: 'online',
          loaded: true,
          strokes: [...message.strokes, ...localOnly],
        });
        return;
      }
      case 'stroke':
        if (this.state.strokes.some((s) => s.id === message.stroke.id)) return;
        this.update({ strokes: [...this.state.strokes, message.stroke] });
        return;
      case 'ack':
        this.outbox.delete(message.id);
        this.update({});
        return;
      case 'rejected':
        console.error('Stroke rejected by the server:', message.error);
        if (message.id !== null && this.outbox.delete(message.id)) {
          this.update({ rejected: this.state.rejected + 1 });
        }
        return;
      case 'not-found':
        // The close event (4404) that follows sets the status.
        return;
    }
  }

  private update(patch: Partial<CanvasState>): void {
    this.state = { ...this.state, ...patch, pending: this.outbox.size };
    for (const listener of this.listeners) listener();
  }
}
