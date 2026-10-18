import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import type { ServerMessage, Stroke } from '@canvas/shared';
import { WebSocket } from 'ws';
import { handleApi } from './api.js';
import { createStrokeStore } from './db/canvases.js';
import { TEST_DATABASE_URL, createTestDatabase } from './db/testing.js';
import type { TestDatabase } from './db/testing.js';
import { attachRealtime } from './realtime.js';
import type { Realtime } from './realtime.js';

/** Collects every message of a socket and lets tests wait for one that matches. */
function inbox(socket: WebSocket) {
  const messages: ServerMessage[] = [];
  const waiters: (() => void)[] = [];
  socket.on('message', (data) => {
    messages.push(JSON.parse(String(data)) as ServerMessage);
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    messages,
    async waitFor<T extends ServerMessage['type']>(
      type: T,
      match: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      for (;;) {
        const found = messages.find(
          (m): m is Extract<ServerMessage, { type: T }> =>
            m.type === type && match(m as Extract<ServerMessage, { type: T }>),
        );
        if (found) return found;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

function stroke(): Stroke {
  return { id: randomUUID(), color: '#16a34a', width: 3, points: [{ x: 10, y: 20 }] };
}

// The whole server against a real database: what the in-memory store of
// realtime.test.ts stands in for.
describe(
  'server with PostgreSQL',
  { skip: TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set' },
  () => {
    let db: TestDatabase;
    let realtime: Realtime;
    const server = createServer((req, res) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      void handleApi(db.pool, req, res, pathname);
    });
    let base = '';
    const sockets: WebSocket[] = [];

    before(async () => {
      db = await createTestDatabase(TEST_DATABASE_URL ?? '');
      realtime = attachRealtime(server, createStrokeStore(db.pool));
      server.listen(0);
      await once(server, 'listening');
      base = `localhost:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      for (const socket of sockets) socket.terminate();
      await realtime?.close();
      server.close();
      await db?.drop();
    });

    async function join(canvasId: string, user: string, since = 0) {
      const socket = new WebSocket(
        `ws://${base}/api/canvases/${canvasId}/ws?user=${user}&since=${since}`,
      );
      sockets.push(socket);
      const box = inbox(socket);
      await box.waitFor('snapshot');
      return { socket, ...box, send: (m: unknown) => socket.send(JSON.stringify(m)) };
    }

    it('creates a canvas, syncs strokes and undo, and serves the picture over REST', async () => {
      const created = await fetch(`http://${base}/api/canvases`, { method: 'POST' });
      assert.equal(created.status, 201);
      const { id } = (await created.json()) as { id: string };

      const alice = await join(id, randomUUID());
      const bob = await join(id, randomUUID());
      const kept = stroke();
      const undone = stroke();

      alice.send({ type: 'stroke', stroke: kept });
      alice.send({ type: 'stroke', stroke: undone });
      alice.send({
        type: 'visibility',
        change: { id: randomUUID(), strokeId: undone.id, visible: false },
      });

      const change = await bob.waitFor('visibility');
      assert.deepEqual(change.change.seq, 3);
      assert.deepEqual(
        bob.messages
          .filter((m) => m.type === 'stroke')
          .map((m) => m.type === 'stroke' && m.stroke.seq),
        [1, 2],
      );

      const picture = await fetch(`http://${base}/api/canvases/${id}`);
      assert.deepEqual(await picture.json(), { id, strokes: [{ ...kept, seq: 1 }] });

      // A late joiner resuming from seq 1 gets the rest, change included.
      const carol = await join(id, randomUUID(), 1);
      const snapshot = await carol.waitFor('snapshot');
      assert.deepEqual(
        snapshot.strokes.map((s) => s.id),
        [undone.id],
      );
      assert.equal(snapshot.changes.length, 1);
    });

    it('saves a stroke posted over REST with the next seq', async () => {
      const { id } = (await (
        await fetch(`http://${base}/api/canvases`, { method: 'POST' })
      ).json()) as {
        id: string;
      };
      const drawn = stroke();
      const post = () =>
        fetch(`http://${base}/api/canvases/${id}/strokes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(drawn),
        });
      const first = await post();
      assert.equal(first.status, 201);
      assert.deepEqual(await first.json(), { id: drawn.id, seq: 1 });
      assert.equal((await post()).status, 200, 'a retry is not saved twice');
      assert.equal((await fetch(`http://${base}/api/canvases/nope`)).status, 404);
    });
  },
);
