import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type {
  SavedStroke,
  SavedVisibility,
  ServerMessage,
  Stroke,
  Visibility,
} from '@canvas/shared';
import { WebSocket } from 'ws';
import type { ChangeResult, InsertResult, StrokeStore } from './db/canvases.js';
import { attachRealtime } from './realtime.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-memory StrokeStore with the same semantics as the PostgreSQL one. */
class MemoryStore implements StrokeStore {
  /** Strokes of each canvas, in seq order. */
  canvases = new Map<string, SavedStroke[]>();
  /** Visibility changes of each canvas, in seq order. */
  changes = new Map<string, SavedVisibility[]>();
  /** Who drew each stroke saved with an author. */
  authors = new Map<string, string>();
  failNextInsert = false;
  existsDelayMs = 0;
  listDelayMs = 0;

  private lastSeq(canvasId: string): number | null {
    const strokes = this.canvases.get(canvasId);
    if (!strokes) return null;
    return Math.max(0, ...strokes.map((s) => s.seq), ...this.changesOf(canvasId).map((c) => c.seq));
  }

  private changesOf(canvasId: string): SavedVisibility[] {
    let list = this.changes.get(canvasId);
    if (!list) {
      list = [];
      this.changes.set(canvasId, list);
    }
    return list;
  }

  async getLastSeq(canvasId: string): Promise<number | null> {
    if (this.existsDelayMs > 0) await sleep(this.existsDelayMs);
    return this.lastSeq(canvasId);
  }

  async listStrokes(canvasId: string, since: number): Promise<SavedStroke[]> {
    // Read before waiting, like a query that sees the database as it was.
    const strokes = (this.canvases.get(canvasId) ?? []).filter((s) => s.seq > since);
    if (this.listDelayMs > 0) await sleep(this.listDelayMs);
    return strokes;
  }

  listChanges(canvasId: string, since: number): Promise<SavedVisibility[]> {
    return Promise.resolve(this.changesOf(canvasId).filter((c) => c.seq > since));
  }

  insertStroke(canvasId: string, stroke: Stroke, authorId: string | null): Promise<InsertResult> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      return Promise.reject(new Error('database down'));
    }
    const strokes = this.canvases.get(canvasId);
    const lastSeq = this.lastSeq(canvasId);
    if (!strokes || lastSeq === null) return Promise.resolve({ status: 'canvas-not-found' });
    for (const [id, list] of this.canvases) {
      const existing = list.find((s) => s.id === stroke.id);
      if (existing && id !== canvasId) return Promise.resolve({ status: 'id-taken' });
      if (existing) return Promise.resolve({ status: 'duplicate', seq: existing.seq });
    }
    const seq = lastSeq + 1;
    strokes.push({ ...stroke, seq });
    if (authorId) this.authors.set(stroke.id, authorId);
    return Promise.resolve({ status: 'created', seq });
  }

  insertChange(canvasId: string, userId: string, change: Visibility): Promise<ChangeResult> {
    const lastSeq = this.lastSeq(canvasId);
    if (lastSeq === null) return Promise.resolve({ status: 'canvas-not-found' });
    for (const [id, list] of this.changes) {
      const existing = list.find((c) => c.id === change.id);
      if (existing && id !== canvasId) return Promise.resolve({ status: 'id-taken' });
      if (existing) return Promise.resolve({ status: 'duplicate', seq: existing.seq });
    }
    if (!this.canvases.get(canvasId)?.some((s) => s.id === change.strokeId)) {
      return Promise.resolve({ status: 'stroke-not-found' });
    }
    if (this.authors.get(change.strokeId) !== userId) {
      return Promise.resolve({ status: 'not-author' });
    }
    const seq = lastSeq + 1;
    this.changesOf(canvasId).push({ ...change, seq });
    return Promise.resolve({ status: 'created', seq });
  }
}

const PRESENCE_TYPES = new Set(['peer-joined', 'peer-left']);

/**
 * A test client that queues incoming messages so tests can await them in
 * order. Presence messages are dropped unless `withPresence` is set, so tests
 * about strokes do not depend on who else joined.
 */
class Client {
  private readonly inbox: ServerMessage[] = [];
  private readonly waiters: ((m: ServerMessage) => void)[] = [];
  readonly closed: Promise<number>;

  constructor(
    readonly socket: WebSocket,
    withPresence: boolean,
  ) {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (!withPresence && PRESENCE_TYPES.has(message.type)) return;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.inbox.push(message);
    });
    this.closed = once(socket, 'close').then(([code]) => code as number);
  }

  next(): Promise<ServerMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** True if no message arrives within a short window. */
  async isQuiet(ms = 50): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.inbox.length === 0;
  }

  /** Every message that arrives within a short window. */
  async drain(ms = 50): Promise<ServerMessage[]> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.inbox.splice(0);
  }

  sendStroke(stroke: unknown): void {
    this.send({ type: 'stroke', stroke });
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
}

function stroke(n: number): Stroke {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    color: '#2563eb',
    width: 4,
    points: [{ x: n, y: n }],
  };
}

function saved(n: number, seq: number): SavedStroke {
  return { ...stroke(n), seq };
}

function change(n: number, strokeN: number, visible = false): Visibility {
  return {
    id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    strokeId: stroke(strokeN).id,
    visible,
  };
}

const ALICE = '00000000-0000-4000-a000-00000000a11c';
const BOB = '00000000-0000-4000-a000-000000000b0b';

describe('realtime', () => {
  const store = new MemoryStore();
  const server = createServer();
  const realtime = attachRealtime(server, store);
  const clients: Client[] = [];
  let baseUrl = '';

  async function connect(
    canvasId: string,
    { query = '', withPresence = false } = {},
  ): Promise<Client> {
    const socket = new WebSocket(`${baseUrl}/api/canvases/${canvasId}/ws${query}`);
    const client = new Client(socket, withPresence);
    clients.push(client);
    await once(socket, 'open');
    return client;
  }

  /** Connects and consumes the welcome and the snapshot. */
  async function join(canvasId: string, options: Parameters<typeof connect>[1] = {}) {
    const client = await connect(canvasId, options);
    assert.equal((await client.next()).type, 'welcome');
    assert.equal((await client.next()).type, 'snapshot');
    return client;
  }

  before(async () => {
    server.listen(0);
    await once(server, 'listening');
    baseUrl = `ws://localhost:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    store.canvases = new Map([
      ['room-a', [saved(1, 1)]],
      ['room-b', []],
    ]);
    store.changes = new Map();
    store.authors = new Map();
  });

  // Every test starts with empty rooms.
  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    store.existsDelayMs = 0;
    store.listDelayMs = 0;
    for (let waited = 0; realtime.roomSizes().size > 0; waited += 5) {
      assert.ok(waited < 1000, 'rooms should empty once their clients are gone');
      await sleep(5);
    }
  });

  after(async () => {
    await realtime.close();
    server.close();
  });

  it('sends who is here and the saved strokes on connect', async () => {
    const client = await connect('room-a');
    assert.deepEqual(await client.next(), { type: 'welcome', peers: [] });
    assert.deepEqual(await client.next(), {
      type: 'snapshot',
      since: 0,
      strokes: [saved(1, 1)],
      changes: [],
    });
  });

  it('saves a stroke, acks the sender and broadcasts to the room only', async () => {
    const alice = await join('room-a');
    const bob = await join('room-a');
    const carol = await join('room-b');

    alice.sendStroke(stroke(2));

    assert.deepEqual(await alice.next(), { type: 'ack', id: stroke(2).id, seq: 2 });
    assert.deepEqual(await bob.next(), { type: 'stroke', stroke: saved(2, 2) });
    assert.ok(await carol.isQuiet());
    assert.ok(await alice.isQuiet(), 'the sender does not get its own stroke back');
    assert.deepEqual(store.canvases.get('room-a'), [saved(1, 1), saved(2, 2)]);
  });

  it('acks a resent stroke with its original seq without broadcasting it again', async () => {
    const alice = await join('room-a');
    const bob = await join('room-a');

    alice.sendStroke(stroke(1));

    assert.deepEqual(await alice.next(), { type: 'ack', id: stroke(1).id, seq: 1 });
    assert.ok(await bob.isQuiet());
  });

  it('rejects a stroke whose id is already used in another canvas', async () => {
    const alice = await join('room-b');

    alice.sendStroke(stroke(1));

    const rejected = await alice.next();
    assert.equal(rejected.type, 'rejected');
    assert.equal(rejected.type === 'rejected' && rejected.id, stroke(1).id);
    assert.deepEqual(store.canvases.get('room-b'), []);
  });

  it('sends only the strokes after `since` to a client that reconnects', async () => {
    const alice = await join('room-a');
    alice.sendStroke(stroke(2));
    alice.sendStroke(stroke(3));
    assert.equal((await alice.next()).type, 'ack');
    assert.equal((await alice.next()).type, 'ack');

    const bob = await connect('room-a', { query: '?since=1' });
    assert.equal((await bob.next()).type, 'welcome');
    assert.deepEqual(await bob.next(), {
      type: 'snapshot',
      since: 1,
      strokes: [saved(2, 2), saved(3, 3)],
      changes: [],
    });

    const carol = await connect('room-a', { query: '?since=3' });
    assert.equal((await carol.next()).type, 'welcome');
    assert.deepEqual(await carol.next(), { type: 'snapshot', since: 3, strokes: [], changes: [] });
  });

  it('sends everything to a client that claims seqs the canvas does not have', async () => {
    const client = await connect('room-a', { query: '?since=7' });
    assert.equal((await client.next()).type, 'welcome');
    assert.deepEqual(await client.next(), {
      type: 'snapshot',
      since: 0,
      strokes: [saved(1, 1)],
      changes: [],
    });
  });

  it('rejects invalid strokes and keeps the connection open', async () => {
    const alice = await join('room-a');

    alice.sendStroke({ ...stroke(2), color: 'red' });
    const rejected = await alice.next();
    assert.equal(rejected.type, 'rejected');
    assert.equal(rejected.type === 'rejected' && rejected.id, stroke(2).id);

    alice.socket.send('not json');
    assert.equal((await alice.next()).type, 'rejected');

    alice.sendStroke(stroke(3));
    assert.deepEqual(await alice.next(), { type: 'ack', id: stroke(3).id, seq: 2 });
  });

  it('closes with 4404 when the canvas does not exist', async () => {
    const client = await connect('missing');
    assert.deepEqual(await client.next(), { type: 'not-found' });
    assert.equal(await client.closed, 4404);
  });

  it('refuses the upgrade on other paths', async () => {
    const socket = new WebSocket(`${baseUrl}/api/canvases/room-a`);
    const [err] = (await once(socket, 'error')) as [Error];
    assert.match(err.message, /404/);
  });

  it('closes with 1011 when saving fails, so the client resends after reconnecting', async () => {
    const alice = await join('room-a');
    store.failNextInsert = true;

    alice.sendStroke(stroke(2));

    assert.equal(await alice.closed, 1011);
  });

  it('announces peers joining and leaving, with their profile', async () => {
    const alice = await join('room-b', { withPresence: true });
    const bob = await connect('room-b', { query: '?name=Bob&color=%23dc2626' });

    const welcome = await bob.next();
    assert.equal(welcome.type, 'welcome');
    const peers = welcome.type === 'welcome' ? welcome.peers : [];
    assert.deepEqual(
      peers.map((p) => [p.name, p.color]),
      [['Anónimo', '#6b7280']],
    );

    const joined = await alice.next();
    assert.equal(joined.type, 'peer-joined');
    const bobPeer = joined.type === 'peer-joined' ? joined.peer : null;
    assert.deepEqual(bobPeer && { ...bobPeer, id: '' }, {
      id: '',
      name: 'Bob',
      color: '#dc2626',
      cursor: null,
    });

    bob.socket.close();
    assert.deepEqual(await alice.next(), { type: 'peer-left', peerId: bobPeer?.id });
  });

  it('relays cursors without saving them and tells newcomers where they are', async () => {
    const alice = await join('room-b');
    const bob = await join('room-b');

    alice.send({ type: 'cursor', position: { x: 5, y: 6 } });
    const cursor = await bob.next();
    assert.equal(cursor.type, 'cursor');
    assert.deepEqual(cursor.type === 'cursor' && cursor.position, { x: 5, y: 6 });
    assert.ok(await alice.isQuiet(), 'the sender does not get its own cursor back');

    const carol = await connect('room-b');
    const welcome = await carol.next();
    const positions = welcome.type === 'welcome' ? welcome.peers.map((p) => p.cursor) : [];
    assert.deepEqual(positions, [{ x: 5, y: 6 }, null]);

    alice.send({ type: 'cursor', position: null });
    const hidden = await bob.next();
    assert.deepEqual(hidden.type === 'cursor' && hidden.position, null);
  });

  it('relays strokes in progress without saving them', async () => {
    const alice = await join('room-a');
    const bob = await join('room-a');

    alice.send({ type: 'live', stroke: stroke(2) });
    const live = await bob.next();
    assert.equal(live.type, 'live');
    assert.deepEqual(live.type === 'live' && live.stroke, stroke(2));
    assert.deepEqual(store.canvases.get('room-a'), [saved(1, 1)]);
  });

  it('drops invalid ephemeral messages silently', async () => {
    const alice = await join('room-a');
    const bob = await join('room-a');

    alice.send({ type: 'cursor', position: { x: 'a', y: 0 } });
    alice.send({ type: 'live', stroke: { ...stroke(2), points: [] } });

    assert.ok(await alice.isQuiet());
    assert.ok(await bob.isQuiet());
  });

  it('cancels a stroke in progress when the final stroke is rejected', async () => {
    const alice = await join('room-a');
    const bob = await join('room-a');

    alice.send({ type: 'live', stroke: stroke(2) });
    assert.equal((await bob.next()).type, 'live');
    alice.sendStroke({ ...stroke(2), width: 0 });

    assert.equal((await alice.next()).type, 'rejected');
    const cancel = await bob.next();
    assert.equal(cancel.type, 'live-cancel');
    assert.equal(cancel.type === 'live-cancel' && cancel.id, stroke(2).id);
  });

  it('rate-limits ephemeral messages per connection', async () => {
    const alice = await join('room-b');
    const bob = await join('room-b');

    const sent = 1000;
    for (let i = 0; i < sent; i++) alice.send({ type: 'cursor', position: { x: i, y: i } });

    const received = (await bob.drain(200)).filter((m) => m.type === 'cursor').length;
    assert.ok(received > 0, 'some cursors get through');
    assert.ok(received < sent / 2, `${received} of ${sent} cursors got through`);

    // Saved strokes are not limited.
    alice.sendStroke(stroke(3));
    assert.deepEqual(await alice.next(), { type: 'ack', id: stroke(3).id, seq: 1 });
  });

  it('does not join a room when the client leaves before the canvas is checked', async () => {
    store.existsDelayMs = 50;
    const client = await connect('room-b');
    client.socket.terminate();
    await sleep(100);

    assert.equal(realtime.roomSizes().get('room-b') ?? 0, 0);
  });

  it('sends operations saved while a snapshot is read after that snapshot', async () => {
    const alice = await join('room-a');
    store.listDelayMs = 50;
    const bob = await connect('room-a');
    assert.equal((await bob.next()).type, 'welcome');

    // Saved after Bob's snapshot was read, but before it was sent.
    await sleep(10);
    alice.sendStroke(stroke(2));
    assert.equal((await alice.next()).type, 'ack');

    assert.deepEqual(await bob.next(), {
      type: 'snapshot',
      since: 0,
      strokes: [saved(1, 1)],
      changes: [],
    });
    assert.deepEqual(await bob.next(), { type: 'stroke', stroke: saved(2, 2) });
  });

  describe('undo and redo', () => {
    it('saves a change by the author, acks it and broadcasts it', async () => {
      const alice = await join('room-b', { query: `?user=${ALICE}` });
      const bob = await join('room-b', { query: `?user=${BOB}` });
      alice.sendStroke(stroke(2));
      assert.deepEqual(await alice.next(), { type: 'ack', id: stroke(2).id, seq: 1 });
      assert.equal((await bob.next()).type, 'stroke');

      alice.send({ type: 'visibility', change: change(1, 2) });
      alice.send({ type: 'visibility', change: change(2, 2, true) });

      assert.deepEqual(await alice.next(), { type: 'ack', id: change(1, 2).id, seq: 2 });
      assert.deepEqual(await alice.next(), { type: 'ack', id: change(2, 2).id, seq: 3 });
      assert.deepEqual(await bob.next(), {
        type: 'visibility',
        change: { ...change(1, 2), seq: 2 },
      });
      assert.deepEqual(await bob.next(), {
        type: 'visibility',
        change: { ...change(2, 2, true), seq: 3 },
      });

      const carol = await connect('room-b', { query: '?since=1' });
      assert.equal((await carol.next()).type, 'welcome');
      assert.deepEqual(await carol.next(), {
        type: 'snapshot',
        since: 1,
        strokes: [],
        changes: [
          { ...change(1, 2), seq: 2 },
          { ...change(2, 2, true), seq: 3 },
        ],
      });
    });

    it('saves an undo sent right after its stroke, in order', async () => {
      const alice = await join('room-b', { query: `?user=${ALICE}` });

      alice.sendStroke(stroke(2));
      alice.send({ type: 'visibility', change: change(1, 2) });

      assert.equal((await alice.next()).type, 'ack');
      assert.deepEqual(await alice.next(), { type: 'ack', id: change(1, 2).id, seq: 2 });
    });

    it('rejects changes to strokes of someone else', async () => {
      const alice = await join('room-b', { query: `?user=${ALICE}` });
      const bob = await join('room-b', { query: `?user=${BOB}` });
      const anonymous = await join('room-b');
      alice.sendStroke(stroke(2));
      assert.equal((await alice.next()).type, 'ack');

      bob.send({ type: 'visibility', change: change(1, 2) });
      anonymous.send({ type: 'visibility', change: change(2, 2) });

      for (const [client, n] of [
        [bob, 1],
        [anonymous, 2],
      ] as const) {
        const messages = (await client.drain()).filter((m) => m.type !== 'stroke');
        assert.deepEqual(messages, [
          { type: 'rejected', id: change(n, 2).id, error: 'only the author can undo a stroke' },
        ]);
      }
      assert.ok(await alice.isQuiet());
      assert.deepEqual(store.changes.get('room-b') ?? [], []);
    });

    it('rejects a change to a stroke that is not in the canvas', async () => {
      const alice = await join('room-b', { query: `?user=${ALICE}` });

      alice.send({ type: 'visibility', change: change(1, 1) });

      assert.deepEqual(await alice.next(), {
        type: 'rejected',
        id: change(1, 1).id,
        error: 'stroke not found',
      });
    });

    it('acks a resent change with its original seq without broadcasting it again', async () => {
      const alice = await join('room-b', { query: `?user=${ALICE}` });
      const bob = await join('room-b');
      alice.sendStroke(stroke(2));
      alice.send({ type: 'visibility', change: change(1, 2) });
      await alice.drain();
      await bob.drain();

      alice.send({ type: 'visibility', change: change(1, 2) });

      assert.deepEqual(await alice.next(), { type: 'ack', id: change(1, 2).id, seq: 2 });
      assert.ok(await bob.isQuiet());
    });

    it('keeps the author across reconnections', async () => {
      const first = await join('room-b', { query: `?user=${ALICE}` });
      first.sendStroke(stroke(2));
      assert.equal((await first.next()).type, 'ack');
      first.socket.close();
      await first.closed;

      const second = await join('room-b', { query: `?user=${ALICE}&since=1` });
      second.send({ type: 'visibility', change: change(1, 2) });

      assert.deepEqual(await second.next(), { type: 'ack', id: change(1, 2).id, seq: 2 });
    });
  });

  it('removes connections from their room when they close', async () => {
    const alice = await join('room-b');
    await join('room-b');
    assert.equal(realtime.roomSizes().get('room-b'), 2);

    alice.socket.close();
    await alice.closed;
    // The server handles the close a tick after the client sees it.
    await sleep(20);

    assert.equal(realtime.roomSizes().get('room-b'), 1);
  });
});
