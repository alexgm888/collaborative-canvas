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

/**
 * Saves a stroke. Returns false if a stroke with the same id already exists,
 * which makes retries after a lost response harmless.
 */
export async function insertStroke(
  db: Queryable,
  canvasId: string,
  stroke: Stroke,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO strokes (id, canvas_id, color, width, points)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    // node-postgres would turn a JS array into a PostgreSQL array, not JSON.
    [stroke.id, canvasId, stroke.color, stroke.width, JSON.stringify(stroke.points)],
  );
  return rowCount === 1;
}
