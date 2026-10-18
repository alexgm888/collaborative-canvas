import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ServerMessage, Stroke } from '@canvas/shared';
import { WebSocket } from 'ws';
import type { InsertResult, StrokeStore } from './db/canvases.js';
import { attachRealtime } from './realtime.js';

/** In-memory StrokeStore with the same semantics as the PostgreSQL one. */
class MemoryStore implements StrokeStore {
  canvases = new Map<string, Stroke[]>();
  failNextInsert = false;

  canvasExists(canvasId: string): Promise<boolean> {
    return Promise.resolve(this.canvases.has(canvasId));
  }

  listStrokes(canvasId: string): Promise<Stroke[]> {
    return Promise.resolve([...(this.canvases.get(canvasId) ?? [])]);
  }

  insertStroke(canvasId: string, stroke: Stroke): Promise<InsertResult> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      return Promise.reject(new Error('database down'));
    }
    const strokes = this.canvases.get(canvasId);
    if (!strokes) return Promise.resolve('canvas-not-found');
    if ([...this.canvases.values()].some((list) => list.some((s) => s.id === stroke.id))) {
      return Promise.resolve('duplicate');
    }
    strokes.push(stroke);
    return Promise.resolve('created');
  }
}

/** A test client that queues incoming messages so tests can await them in order. */
class Client {
  private readonly inbox: ServerMessage[] = [];
  private readonly waiters: ((m: ServerMessage) => void)[] = [];
  readonly closed: Promise<number>;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage;
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

  sendStroke(stroke: unknown): void {
    this.socket.send(JSON.stringify({ type: 'stroke', stroke }));
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

describe('realtime', () => {
  const store = new MemoryStore();
  const server = createServer();
  const realtime = attachRealtime(server, store);
  const clients: Client[] = [];
  let baseUrl = '';

  async function connect(canvasId: string): Promise<Client> {
    const socket = new WebSocket(`${baseUrl}/api/canvases/${canvasId}/ws`);
    const client = new Client(socket);
    clients.push(client);
    await once(socket, 'open');
    return client;
  }

  /** Connects and consumes the snapshot. */
  async function join(canvasId: string): Promise<Client> {
    const client = await connect(canvasId);
    const first = await client.next();
    assert.equal(first.type, 'snapshot');
    return client;
  }

  before(async () => {
    server.listen(0);
    await once(server, 'listening');
    baseUrl = `ws://localhost:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(() => {
    store.canvases = new Map([
      ['room-a', [stroke(1)]],
      ['room-b', []],
    ]);
  });

  after(async () => {
    for (const c of clients) c.socket.terminate();
    await realtime.close();
    server.close();
  });

  it('sends the saved strokes on connect', async () => {
    const client = await connect('room-a');
    assert.deepEqual(await client.next(), { type: 'snapshot', strokes: [stroke(1)] });
  });

  it('saves a stroke, acks the sender and broadcasts to the room only', async () => {
    const alice = await join('room-a');
    const bob = await join('room-a');
    const carol = await join('room-b');

    alice.sendStroke(stroke(2));

    assert.deepEqual(await alice.next(), { type: 'ack', id: stroke(2).id });
    assert.deepEqual(await bob.next(), { type: 'stroke', stroke: stroke(2) });
    assert.ok(await carol.isQuiet());
    assert.ok(await alice.isQuiet(), 'the sender does not get its own stroke back');
    assert.deepEqual(store.canvases.get('room-a'), [stroke(1), stroke(2)]);
  });

  it('acks a resent stroke without broadcasting it again', async () => {
    const alice = await join('room-a');
    const bob = await join('room-a');

    alice.sendStroke(stroke(1));

    assert.deepEqual(await alice.next(), { type: 'ack', id: stroke(1).id });
    assert.ok(await bob.isQuiet());
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
    assert.deepEqual(await alice.next(), { type: 'ack', id: stroke(3).id });
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

  it('removes connections from their room when they close', async () => {
    const alice = await join('room-b');
    const before = realtime.roomSizes().get('room-b') ?? 0;

    alice.socket.close();
    await alice.closed;
    // The server handles the close a tick after the client sees it.
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(realtime.roomSizes().get('room-b') ?? 0, before - 1);
  });
});
