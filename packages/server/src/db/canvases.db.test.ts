import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Stroke } from '@canvas/shared';
import type pg from 'pg';
import {
  createCanvas,
  getLastSeq,
  insertChange,
  insertStroke,
  listChanges,
  listStrokes,
  listVisibleStrokes,
} from './canvases.js';
import { migrate } from './migrate.js';
import { TEST_DATABASE_URL, createTestDatabase } from './testing.js';
import type { TestDatabase } from './testing.js';

function stroke(overrides: Partial<Stroke> = {}): Stroke {
  return {
    id: randomUUID(),
    color: '#2563eb',
    width: 4,
    points: [
      { x: 1, y: 2 },
      { x: 3, y: 4.5 },
    ],
    ...overrides,
  };
}

const ALICE = randomUUID();
const BOB = randomUUID();

let canvasCount = 0;
async function newCanvas(pool: pg.Pool): Promise<string> {
  const id = `canvas-${++canvasCount}`;
  await createCanvas(pool, id);
  return id;
}

describe(
  'PostgreSQL store',
  { skip: TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set' },
  () => {
    let db: TestDatabase;
    let pool: pg.Pool;

    before(async () => {
      db = await createTestDatabase(TEST_DATABASE_URL ?? '');
      pool = db.pool;
    });

    after(async () => {
      await db?.drop();
    });

    describe('migrations', () => {
      it('apply once: running them again, even twice at a time, changes nothing', async () => {
        await Promise.all([migrate(pool), migrate(pool)]);
        const { rows } = await pool.query<{ id: string }>(
          'SELECT id FROM schema_migrations ORDER BY id',
        );
        assert.deepEqual(
          rows.map((r) => r.id),
          ['001_canvases_and_strokes', '002_seq_per_canvas', '003_undo_redo'],
        );
      });
    });

    describe('strokes', () => {
      it('knows which canvases exist and starts them at seq 0', async () => {
        const canvas = await newCanvas(pool);
        assert.equal(await getLastSeq(pool, canvas), 0);
        assert.equal(await getLastSeq(pool, 'missing'), null);
      });

      it('numbers the strokes of each canvas 1, 2, 3… independently', async () => {
        const a = await newCanvas(pool);
        const b = await newCanvas(pool);
        assert.deepEqual(await insertStroke(pool, a, stroke()), { status: 'created', seq: 1 });
        assert.deepEqual(await insertStroke(pool, b, stroke()), { status: 'created', seq: 1 });
        assert.deepEqual(await insertStroke(pool, a, stroke()), { status: 'created', seq: 2 });
        assert.equal(await getLastSeq(pool, a), 2);
      });

      it('round-trips every field, points as JSON', async () => {
        const canvas = await newCanvas(pool);
        const drawn = stroke({ color: '#ff0000', width: 12.5 });
        await insertStroke(pool, canvas, drawn);
        assert.deepEqual(await listStrokes(pool, canvas), [{ ...drawn, seq: 1 }]);
      });

      it('returns the original seq for a resent stroke without using a new one', async () => {
        const canvas = await newCanvas(pool);
        const drawn = stroke();
        await insertStroke(pool, canvas, drawn);
        await insertStroke(pool, canvas, stroke());
        assert.deepEqual(await insertStroke(pool, canvas, drawn), { status: 'duplicate', seq: 1 });
        assert.equal(await getLastSeq(pool, canvas), 2);
      });

      it('refuses an id used in another canvas, and a canvas that does not exist', async () => {
        const a = await newCanvas(pool);
        const b = await newCanvas(pool);
        const drawn = stroke();
        await insertStroke(pool, a, drawn);
        assert.deepEqual(await insertStroke(pool, b, drawn), { status: 'id-taken' });
        assert.deepEqual(await insertStroke(pool, 'missing', stroke()), {
          status: 'canvas-not-found',
        });
        assert.equal(await getLastSeq(pool, b), 0);
      });

      it('rolls the counter back when saving fails, leaving no gap', async () => {
        const canvas = await newCanvas(pool);
        await insertStroke(pool, canvas, stroke());
        // Validation normally stops this; here it makes the INSERT itself fail.
        await assert.rejects(insertStroke(pool, canvas, stroke({ id: 'not-a-uuid' })));
        assert.deepEqual(await insertStroke(pool, canvas, stroke()), { status: 'created', seq: 2 });
      });

      it('keeps seqs gapless and unique under concurrent writes, resends included', async () => {
        const canvas = await newCanvas(pool);
        const strokes = Array.from({ length: 60 }, () => stroke());
        // Every stroke twice, all at once: more writers than pool connections.
        const results = await Promise.all(
          [...strokes, ...strokes].map((s) => insertStroke(pool, canvas, s)),
        );

        const seqs = new Map<string, number>();
        results.forEach((result, i) => {
          assert.ok(result.status === 'created' || result.status === 'duplicate');
          const id = strokes[i % strokes.length]!.id;
          const seen = seqs.get(id);
          if (seen !== undefined) assert.equal(result.seq, seen, 'both copies get the same seq');
          seqs.set(id, result.seq);
        });
        assert.equal(results.filter((r) => r.status === 'created').length, 60);

        const saved = await listStrokes(pool, canvas);
        assert.deepEqual(
          saved.map((s) => s.seq),
          Array.from({ length: 60 }, (_, i) => i + 1),
        );
        assert.equal(await getLastSeq(pool, canvas), 60);
      });

      it('lists only the strokes after `since`', async () => {
        const canvas = await newCanvas(pool);
        for (let i = 0; i < 4; i++) await insertStroke(pool, canvas, stroke());
        assert.deepEqual(
          (await listStrokes(pool, canvas, 2)).map((s) => s.seq),
          [3, 4],
        );
        assert.deepEqual(await listStrokes(pool, canvas, 4), []);
      });
    });

    describe('visibility changes', () => {
      it('hide and show a stroke of its author, in the same seq as strokes', async () => {
        const canvas = await newCanvas(pool);
        const drawn = stroke();
        await insertStroke(pool, canvas, drawn, ALICE);
        const undo = { id: randomUUID(), strokeId: drawn.id, visible: false };
        assert.deepEqual(await insertChange(pool, canvas, ALICE, undo), {
          status: 'created',
          seq: 2,
        });
        assert.deepEqual(await listVisibleStrokes(pool, canvas), []);
        assert.equal((await listStrokes(pool, canvas)).length, 1, 'hidden, not deleted');

        const redo = { id: randomUUID(), strokeId: drawn.id, visible: true };
        await insertChange(pool, canvas, ALICE, redo);
        assert.deepEqual(await listVisibleStrokes(pool, canvas), [{ ...drawn, seq: 1 }]);
        assert.deepEqual(await listChanges(pool, canvas), [
          { ...undo, seq: 2 },
          { ...redo, seq: 3 },
        ]);
        assert.deepEqual(await listChanges(pool, canvas, 2), [{ ...redo, seq: 3 }]);
      });

      it('refuse anyone but the author, and strokes without one', async () => {
        const canvas = await newCanvas(pool);
        const alices = stroke();
        const anonymous = stroke();
        await insertStroke(pool, canvas, alices, ALICE);
        await insertStroke(pool, canvas, anonymous, null);
        const hide = (strokeId: string) => ({ id: randomUUID(), strokeId, visible: false });

        assert.deepEqual(await insertChange(pool, canvas, BOB, hide(alices.id)), {
          status: 'not-author',
        });
        assert.deepEqual(await insertChange(pool, canvas, ALICE, hide(anonymous.id)), {
          status: 'not-author',
        });
        assert.equal(await getLastSeq(pool, canvas), 2, 'refused changes use no seq');
        assert.equal((await listVisibleStrokes(pool, canvas)).length, 2);
      });

      it('refuse a stroke of another canvas', async () => {
        const a = await newCanvas(pool);
        const b = await newCanvas(pool);
        const drawn = stroke();
        await insertStroke(pool, a, drawn, ALICE);
        const change = { id: randomUUID(), strokeId: drawn.id, visible: false };
        assert.deepEqual(await insertChange(pool, b, ALICE, change), {
          status: 'stroke-not-found',
        });
      });

      it('return the original seq for a resent change, and refuse its id elsewhere', async () => {
        const a = await newCanvas(pool);
        const b = await newCanvas(pool);
        const drawn = stroke();
        await insertStroke(pool, a, drawn, ALICE);
        const change = { id: randomUUID(), strokeId: drawn.id, visible: false };
        await insertChange(pool, a, ALICE, change);
        assert.deepEqual(await insertChange(pool, a, ALICE, change), {
          status: 'duplicate',
          seq: 2,
        });
        assert.deepEqual(await insertChange(pool, b, ALICE, change), { status: 'id-taken' });
        assert.equal(await getLastSeq(pool, a), 2);
      });

      it('interleave with concurrent strokes without gaps', async () => {
        const canvas = await newCanvas(pool);
        const mine = Array.from({ length: 20 }, () => stroke());
        for (const s of mine) await insertStroke(pool, canvas, s, ALICE);
        await Promise.all([
          ...mine.map((s) =>
            insertChange(pool, canvas, ALICE, { id: randomUUID(), strokeId: s.id, visible: false }),
          ),
          ...Array.from({ length: 20 }, () => insertStroke(pool, canvas, stroke(), BOB)),
        ]);
        const seqs = [
          ...(await listStrokes(pool, canvas)).map((s) => s.seq),
          ...(await listChanges(pool, canvas)).map((c) => c.seq),
        ].sort((x, y) => x - y);
        assert.deepEqual(
          seqs,
          Array.from({ length: 60 }, (_, i) => i + 1),
        );
        assert.equal((await listVisibleStrokes(pool, canvas)).length, 20);
      });
    });
  },
);
