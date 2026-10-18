import type { Point, Stroke } from '@canvas/shared';
import type { Queryable } from './pool.js';

interface StrokeRow {
  id: string;
  color: string;
  width: number;
  points: Point[];
}

export async function createCanvas(db: Queryable, id: string): Promise<void> {
  await db.query('INSERT INTO canvases (id) VALUES ($1)', [id]);
}

export async function canvasExists(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM canvases WHERE id = $1', [id]);
  return rowCount === 1;
}

/** All strokes of a canvas, in the order they were saved. */
export async function listStrokes(db: Queryable, canvasId: string): Promise<Stroke[]> {
  const { rows } = await db.query<StrokeRow>(
    'SELECT id, color, width, points FROM strokes WHERE canvas_id = $1 ORDER BY seq',
    [canvasId],
  );
  return rows;
}

// PostgreSQL error code for a foreign key violation.
const FOREIGN_KEY_VIOLATION = '23503';

export type InsertResult = 'created' | 'duplicate' | 'canvas-not-found';

/**
 * Saves a stroke. A stroke whose id already exists is a 'duplicate', which
 * makes retries after a lost response harmless.
 */
export async function insertStroke(
  db: Queryable,
  canvasId: string,
  stroke: Stroke,
): Promise<InsertResult> {
  try {
    const { rowCount } = await db.query(
      `INSERT INTO strokes (id, canvas_id, color, width, points)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      // node-postgres would turn a JS array into a PostgreSQL array, not JSON.
      [stroke.id, canvasId, stroke.color, stroke.width, JSON.stringify(stroke.points)],
    );
    return rowCount === 1 ? 'created' : 'duplicate';
  } catch (err) {
    // Checking the canvas first would cost a query on every stroke; the
    // foreign key already enforces it.
    if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) return 'canvas-not-found';
    throw err;
  }
}

/** What the real-time layer needs from the database, so tests can swap it. */
export interface StrokeStore {
  canvasExists(canvasId: string): Promise<boolean>;
  listStrokes(canvasId: string): Promise<Stroke[]>;
  insertStroke(canvasId: string, stroke: Stroke): Promise<InsertResult>;
}

export function createStrokeStore(db: Queryable): StrokeStore {
  return {
    canvasExists: (canvasId) => canvasExists(db, canvasId),
    listStrokes: (canvasId) => listStrokes(db, canvasId),
    insertStroke: (canvasId, stroke) => insertStroke(db, canvasId, stroke),
  };
}
