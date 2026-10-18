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

/** Someone else with the canvas open. Names and colors are chosen by each client. */
export interface Peer {
  /** Assigned by the server per connection, so it changes when someone reconnects. */
  id: string;
  name: string;
  color: string;
  /** Pointer position in canvas coordinates, or null when it is off the canvas. */
  cursor: Point | null;
}

/** Messages a client sends. */
export type ClientMessage =
  /** A finished stroke, to save and share. */
  | { type: 'stroke'; stroke: Stroke }
  /**
   * A stroke still being drawn. `points` holds only the points added since the
   * previous `live` message for the same id. Not saved: the final `stroke`
   * replaces it.
   */
  | { type: 'live'; stroke: Stroke }
  | { type: 'cursor'; position: Point | null };

/** Messages the server sends. */
export type ServerMessage =
  /** Sent as soon as you join the room: who else is here. */
  | { type: 'welcome'; peers: Peer[] }
  /** Every stroke saved so far, in order. Arrives after `welcome`. */
  | { type: 'snapshot'; strokes: Stroke[] }
  /** A stroke drawn by someone else in the same canvas, already saved. */
  | { type: 'stroke'; stroke: Stroke }
  /** Your stroke with this id is saved (also sent when it already was). */
  | { type: 'ack'; id: string }
  /** Your stroke with this id is invalid and will never be saved. */
  | { type: 'rejected'; id: string | null; error: string }
  /** The canvas does not exist; the server closes the connection after this. */
  | { type: 'not-found' }
  | { type: 'peer-joined'; peer: Peer }
  /** The peer left; drop its cursor and the strokes it was drawing. */
  | { type: 'peer-left'; peerId: string }
  | { type: 'cursor'; peerId: string; position: Point | null }
  /** New points of a stroke a peer is drawing (see the client `live` message). */
  | { type: 'live'; peerId: string; stroke: Stroke }
  /** The peer's stroke in progress will never be saved; stop showing it. */
  | { type: 'live-cancel'; peerId: string; id: string };
