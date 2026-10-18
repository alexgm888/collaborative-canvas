import type { Point, SavedStroke, SavedVisibility, Stroke, Visibility } from '@canvas/shared';
import type pg from 'pg';
import type { Queryable } from './pool.js';

interface StrokeRow {
  id: string;
  color: string;
  width: number;
  points: Point[];
  // bigint columns arrive as strings: they may not fit in a JS number.
  seq: string;
}

interface VisibilityRow {
  id: string;
  stroke_id: string;
  visible: boolean;
  seq: string;
}

export async function createCanvas(db: Queryable, id: string): Promise<void> {
  await db.query('INSERT INTO canvases (id) VALUES ($1)', [id]);
}

/** The seq of the canvas's latest operation (0 when empty), or null if it does not exist. */
export async function getLastSeq(db: Queryable, id: string): Promise<number | null> {
  const { rows } = await db.query<{ last_seq: string }>(
    'SELECT last_seq FROM canvases WHERE id = $1',
    [id],
  );
  return rows[0] ? Number(rows[0].last_seq) : null;
}

/**
 * The strokes of a canvas with a seq above `since`, in order. Hidden ones are
 * included: their author may show them again.
 */
export async function listStrokes(
  db: Queryable,
  canvasId: string,
  since = 0,
): Promise<SavedStroke[]> {
  const { rows } = await db.query<StrokeRow>(
    `SELECT id, color, width, points, seq FROM strokes
     WHERE canvas_id = $1 AND seq > $2
     ORDER BY seq`,
    [canvasId, since],
  );
  return rows.map((row) => ({ ...row, seq: Number(row.seq) }));
}

/** The strokes of a canvas that are visible now, in order: the picture as it is. */
export async function listVisibleStrokes(db: Queryable, canvasId: string): Promise<SavedStroke[]> {
  const { rows } = await db.query<StrokeRow>(
    `SELECT id, color, width, points, seq FROM strokes
     WHERE canvas_id = $1 AND visible
     ORDER BY seq`,
    [canvasId],
  );
  return rows.map((row) => ({ ...row, seq: Number(row.seq) }));
}

/** The visibility changes of a canvas with a seq above `since`, in order. */
export async function listChanges(
  db: Queryable,
  canvasId: string,
  since = 0,
): Promise<SavedVisibility[]> {
  const { rows } = await db.query<VisibilityRow>(
    `SELECT id, stroke_id, visible, seq FROM stroke_visibility
     WHERE canvas_id = $1 AND seq > $2
     ORDER BY seq`,
    [canvasId, since],
  );
  return rows.map((row) => ({
    id: row.id,
    strokeId: row.stroke_id,
    visible: row.visible,
    seq: Number(row.seq),
  }));
}

export type InsertResult =
  /** Saved now as `seq`. */
  | { status: 'created'; seq: number }
  /** Already saved in this canvas as `seq`, which makes retries harmless. */
  | { status: 'duplicate'; seq: number }
  /** Another canvas has an operation with this id; it can never be saved here. */
  | { status: 'id-taken' }
  | { status: 'canvas-not-found' };

export type ChangeResult =
  | InsertResult
  /** The stroke is not saved in this canvas. */
  | { status: 'stroke-not-found' }
  /** Someone else drew the stroke, or it is from before strokes had authors. */
  | { status: 'not-author' };

/**
 * Runs `save` with the next seq of the canvas, inside a transaction.
 *
 * Taking the seq locks the canvas row until the transaction ends, so the
 * operations of a canvas are saved one after another and seqs commit in
 * order. Anything but `created` rolls the counter back with it, which is what
 * keeps seqs free of gaps: a client can then tell that it has every operation
 * up to N just by having each number up to N.
 */
async function withNextSeq<R extends { status: string }>(
  pool: pg.Pool,
  canvasId: string,
  save: (client: pg.PoolClient, seq: number) => Promise<R>,
): Promise<R | { status: 'canvas-not-found' }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counter = await client.query<{ last_seq: string }>(
      'UPDATE canvases SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq',
      [canvasId],
    );
    const seq = counter.rows[0]?.last_seq;
    const result =
      seq === undefined ? { status: 'canvas-not-found' as const } : await save(client, Number(seq));
    await client.query(result.status === 'created' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Saves a stroke with the next seq of its canvas. `authorId` is who may undo
 * it; null means nobody.
 */
export function insertStroke(
  pool: pg.Pool,
  canvasId: string,
  stroke: Stroke,
  authorId: string | null = null,
): Promise<InsertResult> {
  return withNextSeq<InsertResult>(pool, canvasId, async (client, seq) => {
    const { rowCount } = await client.query(
      `INSERT INTO strokes (id, canvas_id, seq, author_id, color, width, points)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      // node-postgres would turn a JS array into a PostgreSQL array, not JSON.
      [
        stroke.id,
        canvasId,
        seq,
        authorId,
        stroke.color,
        stroke.width,
        JSON.stringify(stroke.points),
      ],
    );
    if (rowCount === 1) return { status: 'created', seq };

    // Stroke ids are unique across canvases (decision 008).
    const existing = await client.query<{ canvas_id: string; seq: string }>(
      'SELECT canvas_id, seq FROM strokes WHERE id = $1',
      [stroke.id],
    );
    const row = existing.rows[0];
    if (row?.canvas_id !== canvasId) return { status: 'id-taken' };
    return { status: 'duplicate', seq: Number(row.seq) };
  });
}

/**
 * Saves a change of visibility with the next seq of its canvas, if `userId`
 * drew the stroke. Changes of a stroke apply in seq order: the last one wins.
 */
export function insertChange(
  pool: pg.Pool,
  canvasId: string,
  userId: string,
  change: Visibility,
): Promise<ChangeResult> {
  return withNextSeq<ChangeResult>(pool, canvasId, async (client, seq) => {
    // A resend is acked with its original seq before anything else is
    // checked. No race: a concurrent resend waits on the canvas row lock and
    // sees this row once it gets the lock.
    const existing = await client.query<{ canvas_id: string; seq: string }>(
      'SELECT canvas_id, seq FROM stroke_visibility WHERE id = $1',
      [change.id],
    );
    const previous = existing.rows[0];
    if (previous) {
      return previous.canvas_id === canvasId
        ? { status: 'duplicate', seq: Number(previous.seq) }
        : { status: 'id-taken' };
    }

    const target = await client.query<{ author_id: string | null }>(
      'SELECT author_id FROM strokes WHERE id = $1 AND canvas_id = $2',
      [change.strokeId, canvasId],
    );
    const stroke = target.rows[0];
    if (!stroke) return { status: 'stroke-not-found' };
    if (stroke.author_id !== userId) return { status: 'not-author' };

    await client.query(
      `INSERT INTO stroke_visibility (id, canvas_id, seq, stroke_id, visible)
       VALUES ($1, $2, $3, $4, $5)`,
      [change.id, canvasId, seq, change.strokeId, change.visible],
    );
    await client.query('UPDATE strokes SET visible = $2 WHERE id = $1', [
      change.strokeId,
      change.visible,
    ]);
    return { status: 'created', seq };
  });
}

/** What the real-time layer needs from the database, so tests can swap it. */
export interface StrokeStore {
  getLastSeq(canvasId: string): Promise<number | null>;
  listStrokes(canvasId: string, since: number): Promise<SavedStroke[]>;
  listChanges(canvasId: string, since: number): Promise<SavedVisibility[]>;
  insertStroke(canvasId: string, stroke: Stroke, authorId: string | null): Promise<InsertResult>;
  insertChange(canvasId: string, userId: string, change: Visibility): Promise<ChangeResult>;
}

export function createStrokeStore(pool: pg.Pool): StrokeStore {
  return {
    getLastSeq: (canvasId) => getLastSeq(pool, canvasId),
    listStrokes: (canvasId, since) => listStrokes(pool, canvasId, since),
    listChanges: (canvasId, since) => listChanges(pool, canvasId, since),
    insertStroke: (canvasId, stroke, authorId) => insertStroke(pool, canvasId, stroke, authorId),
    insertChange: (canvasId, userId, change) => insertChange(pool, canvasId, userId, change),
  };
}
