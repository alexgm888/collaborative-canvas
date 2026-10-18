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

// --- Real-time protocol -----------------------------------------------------
// One WebSocket per open canvas, at `/api/canvases/:id/ws`. Messages are JSON.
// This package only holds types: the server's runtime never imports it.

/** Messages a client sends. */
export type ClientMessage = { type: 'stroke'; stroke: Stroke };

/** Messages the server sends. */
export type ServerMessage =
  /** First message after connecting: every stroke saved so far, in order. */
  | { type: 'snapshot'; strokes: Stroke[] }
  /** A stroke drawn by someone else in the same canvas, already saved. */
  | { type: 'stroke'; stroke: Stroke }
  /** Your stroke with this id is saved (also sent when it already was). */
  | { type: 'ack'; id: string }
  /** Your stroke with this id is invalid and will never be saved. */
  | { type: 'rejected'; id: string | null; error: string }
  /** The canvas does not exist; the server closes the connection after this. */
  | { type: 'not-found' };
