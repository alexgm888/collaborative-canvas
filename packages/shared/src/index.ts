export interface Point {
  x: number;
  y: number;
}

/**
 * A stroke is the unit of drawing. Modelling the canvas as a list of strokes
 * (instead of pixels) is what will later make it possible to sync, replay and
 * undo drawings across users.
 */
export interface Stroke {
  id: string;
  color: string;
  width: number;
  points: Point[];
}
