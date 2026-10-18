import type { Point, SavedStroke, Stroke } from '@canvas/shared';
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

export async function createCanvas(db: Queryable, id: string): Promise<void> {
  await db.query('INSERT INTO canvases (id) VALUES ($1)', [id]);
}

/** The seq of the canvas's latest stroke (0 when empty), or null if it does not exist. */
export async function getLastSeq(db: Queryable, id: string): Promise<number | null> {
  const { rows } = await db.query<{ last_seq: string }>(
    'SELECT last_seq FROM canvases WHERE id = $1',
    [id],
  );
  return rows[0] ? Number(rows[0].last_seq) : null;
}

/** The strokes of a canvas with a seq above `since`, in order. */
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

export type InsertResult =
  /** Saved now as `seq`. */
  | { status: 'created'; seq: number }
  /** Already saved in this canvas as `seq`, which makes retries harmless. */
  | { status: 'duplicate'; seq: number }
  /** Another canvas has a stroke with this id; it can never be saved here. */
  | { status: 'id-taken' }
  | { status: 'canvas-not-found' };

/**
 * Saves a stroke with the next seq of its canvas.
 *
 * Taking the seq locks the canvas row until the transaction ends, so strokes
 * of the same canvas are saved one after another and seqs commit in order.
 * Anything that does not save the stroke rolls the counter back with it,
 * which is what keeps seqs free of gaps: a client can then tell that it has
 * every stroke up to N just by having each number up to N.
 */
export async function insertStroke(
  pool: pg.Pool,
  canvasId: string,
  stroke: Stroke,
): Promise<InsertResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await insertInTransaction(client, canvasId, stroke);
    await client.query(result.status === 'created' ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function insertInTransaction(
  client: pg.PoolClient,
  canvasId: string,
  stroke: Stroke,
): Promise<InsertResult> {
  const counter = await client.query<{ last_seq: string }>(
    'UPDATE canvases SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq',
    [canvasId],
  );
  const seq = counter.rows[0]?.last_seq;
  if (seq === undefined) return { status: 'canvas-not-found' };

  const { rowCount } = await client.query(
    `INSERT INTO strokes (id, canvas_id, seq, color, width, points)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    // node-postgres would turn a JS array into a PostgreSQL array, not JSON.
    [stroke.id, canvasId, seq, stroke.color, stroke.width, JSON.stringify(stroke.points)],
  );
  if (rowCount === 1) return { status: 'created', seq: Number(seq) };

  // Stroke ids are unique across canvases (decision 008).
  const existing = await client.query<{ canvas_id: string; seq: string }>(
    'SELECT canvas_id, seq FROM strokes WHERE id = $1',
    [stroke.id],
  );
  const row = existing.rows[0];
  if (row?.canvas_id !== canvasId) return { status: 'id-taken' };
  return { status: 'duplicate', seq: Number(row.seq) };
}

/** What the real-time layer needs from the database, so tests can swap it. */
export interface StrokeStore {
  getLastSeq(canvasId: string): Promise<number | null>;
  listStrokes(canvasId: string, since: number): Promise<SavedStroke[]>;
  insertStroke(canvasId: string, stroke: Stroke): Promise<InsertResult>;
}

export function createStrokeStore(pool: pg.Pool): StrokeStore {
  return {
    getLastSeq: (canvasId) => getLastSeq(pool, canvasId),
    listStrokes: (canvasId, since) => listStrokes(pool, canvasId, since),
    insertStroke: (canvasId, stroke) => insertStroke(pool, canvasId, stroke),
  };
}
