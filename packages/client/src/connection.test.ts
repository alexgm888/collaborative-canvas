/// <reference types="node" />
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type {
  ClientMessage,
  EphemeralMessage,
  Point,
  SavedStroke,
  ServerMessage,
  Stroke,
} from '@canvas/shared';
import { CanvasConnection } from './connection';

/**
 * Stands in for the browser's WebSocket: tests open, feed and drop each
 * connection by hand and read what the client sent.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string): void {
    assert.equal(this.readyState, FakeSocket.OPEN, 'only sends while open');
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(code = 1000): void {
    this.drop(code);
  }

  // Test controls.
  open(): this {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
    return this;
  }

  receive(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }

  get since(): string | null {
    return new URL(this.url).searchParams.get('since');
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.WebSocket = FakeSocket;
globals.window = { location: { protocol: 'http:', host: 'canvas.test' } };

const IDENTITY = { name: 'Nutria audaz', color: '#e11d48', userId: 'user-1' };

function stroke(n: number): Stroke {
  return { id: `id-${n}`, color: '#2563eb', width: 4, points: [{ x: n, y: n }] };
}

function saved(n: number, seq = n): SavedStroke {
  return { ...stroke(n), seq };
}

const latest = () => FakeSocket.all[FakeSocket.all.length - 1]!;
const drawn = (conn: CanvasConnection) => conn.getState().strokes.map((s) => s.id);

/** Opens the current socket and answers like the server does on join. */
function serve(strokes: SavedStroke[] = [], since = 0): FakeSocket {
  const socket = latest().open();
  socket.receive({ type: 'welcome', you: 'me', peers: [] });
  socket.receive({ type: 'snapshot', since, strokes, changes: [] });
  return socket;
}

/** Waits past the longest reconnection delay, so the next socket exists. */
function reconnect(): FakeSocket {
  const before = FakeSocket.all.length;
  mock.timers.tick(20_000);
  assert.equal(FakeSocket.all.length, before + 1, 'a new socket was opened');
  return latest();
}

describe('CanvasConnection', () => {
  let conn: CanvasConnection;

  beforeEach(() => {
    FakeSocket.all = [];
    mock.timers.enable({ apis: ['setTimeout'] });
    conn = new CanvasConnection('canvas-1', IDENTITY);
  });

  afterEach(() => {
    conn.close();
    mock.timers.reset();
  });

  it('connects with its profile, user and since=0, and loads the snapshot', () => {
    const url = new URL(latest().url);
    assert.equal(url.pathname, '/api/canvases/canvas-1/ws');
    assert.equal(url.searchParams.get('user'), 'user-1');
    assert.equal(url.searchParams.get('name'), 'Nutria audaz');
    assert.equal(latest().since, '0');
    assert.equal(conn.getState().status, 'connecting');

    serve([saved(1), saved(2)]);
    assert.equal(conn.getState().status, 'online');
    assert.equal(conn.getState().loaded, true);
    assert.deepEqual(drawn(conn), ['id-1', 'id-2']);
  });

  it('draws own strokes at once and keeps them pending until acked', () => {
    const socket = serve();
    conn.addStroke(stroke(1));
    assert.deepEqual(drawn(conn), ['id-1']);
    assert.deepEqual(socket.sent, [{ type: 'stroke', stroke: stroke(1) }]);
    assert.equal(conn.getState().pending, 1);

    socket.receive({ type: 'ack', id: 'id-1', seq: 1 });
    assert.equal(conn.getState().pending, 0);
  });

  it('sends strokes drawn while connecting once the socket opens', () => {
    conn.addStroke(stroke(1));
    const socket = serve();
    assert.deepEqual(socket.sent, [{ type: 'stroke', stroke: stroke(1) }]);
  });

  it('resends unacked strokes and changes in order after reconnecting from its last seq', () => {
    const first = serve([saved(1), saved(2)]);
    conn.addStroke(stroke(3));
    conn.undo();
    first.drop();
    assert.equal(conn.getState().status, 'offline');
    assert.deepEqual(drawn(conn), ['id-1', 'id-2'], 'the undo stays applied while offline');

    const second = reconnect();
    assert.equal(second.since, '2');
    second.open();
    assert.deepEqual(
      second.sent.map((m) => (m.type === 'stroke' ? m.stroke.id : m.type)),
      ['id-3', 'visibility'],
    );
    assert.equal(conn.getState().pending, 2);
  });

  it('drops from the outbox what a snapshot shows was saved before the ack was lost', () => {
    const first = serve();
    conn.addStroke(stroke(1));
    first.drop();

    const second = reconnect();
    serve([saved(1)]);
    assert.equal(conn.getState().pending, 0);
    assert.deepEqual(drawn(conn), ['id-1']);
    assert.equal(second.sent.length, 1, 'resent once, before the snapshot came');
  });

  it('merges strokes of others in seq order and resumes after the highest gapless one', () => {
    const first = serve([saved(1)]);
    first.receive({ type: 'stroke', stroke: saved(3) });
    first.receive({ type: 'stroke', stroke: saved(2) });
    assert.deepEqual(drawn(conn), ['id-1', 'id-2', 'id-3']);
    first.receive({ type: 'stroke', stroke: saved(5) });
    first.drop();
    assert.equal(reconnect().since, '3', 'seq 4 is missing, so it asks from 3');
  });

  it('backs off between attempts and stops for good on 4404', () => {
    latest().drop();
    mock.timers.tick(200);
    assert.equal(FakeSocket.all.length, 1, 'does not reconnect immediately');
    reconnect().drop(4404);
    assert.equal(conn.getState().status, 'not-found');
    mock.timers.tick(60_000);
    assert.equal(FakeSocket.all.length, 2);
  });

  describe('undo and redo', () => {
    it('hide and show own strokes, newest first', () => {
      const socket = serve([saved(1)]);
      conn.addStroke(stroke(2));
      conn.addStroke(stroke(3));
      socket.receive({ type: 'ack', id: 'id-2', seq: 2 });
      socket.receive({ type: 'ack', id: 'id-3', seq: 3 });

      conn.undo();
      assert.deepEqual(drawn(conn), ['id-1', 'id-2']);
      conn.undo();
      assert.deepEqual(drawn(conn), ['id-1'], 'the stroke of someone else stays');
      assert.equal(conn.getState().canUndo, false);
      conn.redo();
      assert.deepEqual(drawn(conn), ['id-1', 'id-2']);

      const changes = socket.sent.filter((m) => m.type === 'visibility');
      assert.deepEqual(
        changes.map((m) => m.type === 'visibility' && [m.change.strokeId, m.change.visible]),
        [
          ['id-3', false],
          ['id-2', false],
          ['id-2', true],
        ],
      );
    });

    it('drawing a new stroke clears what redo would show', () => {
      serve();
      conn.addStroke(stroke(1));
      conn.undo();
      assert.equal(conn.getState().canRedo, true);
      conn.addStroke(stroke(2));
      assert.equal(conn.getState().canRedo, false);
    });

    it('revert a change the server refuses', () => {
      const socket = serve();
      conn.addStroke(stroke(1));
      socket.receive({ type: 'ack', id: 'id-1', seq: 1 });
      conn.undo();
      const undo = socket.sent.find((m) => m.type === 'visibility');
      assert.ok(undo?.type === 'visibility');

      socket.receive({ type: 'rejected', id: undo.change.id, error: 'nope' });
      assert.deepEqual(drawn(conn), ['id-1']);
      assert.equal(conn.getState().canRedo, false);
      assert.equal(conn.getState().pending, 0);
    });

    it('keep a refused stroke on screen, counted, but out of the history', () => {
      const socket = serve();
      conn.addStroke(stroke(1));
      socket.receive({ type: 'rejected', id: 'id-1', error: 'too many points' });
      assert.deepEqual(drawn(conn), ['id-1']);
      assert.equal(conn.getState().rejected, 1);
      assert.equal(conn.getState().canUndo, false);
    });
  });

  describe('presence', () => {
    const peer = { id: 'peer-1', name: 'Zorro veloz', color: '#059669', cursor: null };

    const live = (s: Stroke, peerId = 'peer-1'): EphemeralMessage => ({
      type: 'live',
      peerId,
      stroke: s,
    });
    const cursor = (position: Point | null, peerId = 'peer-1'): EphemeralMessage => ({
      type: 'cursor',
      peerId,
      position,
    });

    it('replaces a stroke in progress with the saved one and ignores late points', () => {
      const socket = serve();
      socket.receive({ type: 'peer-joined', peer });
      socket.receive({
        type: 'batch',
        messages: [live({ ...stroke(1), points: [{ x: 0, y: 0 }] })],
      });
      socket.receive({
        type: 'batch',
        messages: [live({ ...stroke(1), points: [{ x: 1, y: 1 }] })],
      });
      assert.equal(conn.getState().live[0]?.points.length, 2, 'points accumulate');

      socket.receive({ type: 'stroke', stroke: saved(1) });
      assert.deepEqual(conn.getState().live, []);
      socket.receive({ type: 'batch', messages: [live(stroke(1))] });
      assert.deepEqual(conn.getState().live, []);
    });

    it('applies a whole batch in one update and skips its own messages', () => {
      const socket = serve();
      socket.receive({ type: 'peer-joined', peer });
      socket.receive({ type: 'peer-joined', peer: { ...peer, id: 'peer-2' } });
      let updates = 0;
      conn.subscribe(() => updates++);

      socket.receive({
        type: 'batch',
        messages: [
          live(stroke(1)),
          live(stroke(2), 'me'),
          cursor({ x: 1, y: 1 }),
          cursor({ x: 2, y: 2 }, 'peer-2'),
          cursor({ x: 3, y: 3 }, 'me'),
        ],
      });
      assert.equal(updates, 1);
      assert.deepEqual(
        conn.getState().live.map((s) => s.id),
        ['id-1'],
      );
      assert.deepEqual(
        conn.getState().peers.map((p) => p.cursor),
        [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      );

      socket.receive({ type: 'batch', messages: [cursor({ x: 4, y: 4 }, 'me')] });
      assert.equal(updates, 1, 'nothing changed, nothing to render');
    });

    it('forgets peers and their strokes in progress when they leave or the socket drops', () => {
      const socket = serve();
      socket.receive({ type: 'peer-joined', peer });
      socket.receive({ type: 'batch', messages: [cursor({ x: 5, y: 6 })] });
      assert.deepEqual(conn.getState().peers[0]?.cursor, { x: 5, y: 6 });
      socket.receive({ type: 'batch', messages: [live(stroke(1))] });

      socket.receive({ type: 'peer-left', peerId: 'peer-1' });
      assert.deepEqual(conn.getState().peers, []);
      assert.deepEqual(conn.getState().live, []);

      socket.receive({ type: 'peer-joined', peer });
      socket.drop();
      assert.deepEqual(conn.getState().peers, []);
    });

    it('throttles cursors: the first goes out at once, the last one after the interval', () => {
      const socket = serve();
      conn.moveCursor({ x: 1, y: 1 });
      mock.timers.tick(1);
      for (let x = 2; x <= 10; x++) conn.moveCursor({ x, y: x });
      mock.timers.tick(10);
      assert.equal(socket.sent.length, 1);
      mock.timers.tick(50);
      assert.deepEqual(socket.sent, [
        { type: 'cursor', position: { x: 1, y: 1 } },
        { type: 'cursor', position: { x: 10, y: 10 } },
      ]);
    });

    it('sends only the new points of the stroke being drawn', () => {
      const socket = serve();
      const inProgress = { ...stroke(1), points: [{ x: 0, y: 0 }] };
      conn.updateLiveStroke(inProgress);
      mock.timers.tick(1);
      inProgress.points.push({ x: 1, y: 1 }, { x: 2, y: 2 });
      conn.updateLiveStroke(inProgress);
      mock.timers.tick(60);
      assert.deepEqual(
        socket.sent.map((m) => m.type === 'live' && m.stroke.points.length),
        [1, 2],
      );
    });
  });
});
