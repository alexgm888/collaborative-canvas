import type { SavedStroke, Stroke } from '@canvas/shared';

/**
 * The strokes of a canvas as this client knows them: the saved ones in seq
 * order, then its own strokes that are not saved (waiting for an ack, or
 * rejected). Every client draws saved strokes in the same order, whatever
 * order they arrived in.
 *
 * `lastSeq` is the highest seq up to which every stroke is here. It is what
 * a reconnection asks to resume from. It is not simply the highest seq seen:
 * strokes saved at the same time can arrive out of order, and with 5 and 7
 * here but not 6, resuming from 7 would lose 6 for good.
 */
export class StrokeLog {
  private saved: SavedStroke[] = [];
  private readonly savedIds = new Set<string>();
  private readonly seqs = new Set<number>();
  private local: Stroke[] = [];
  private contiguous = 0;

  get lastSeq(): number {
    return this.contiguous;
  }

  has(id: string): boolean {
    return this.savedIds.has(id) || this.local.some((s) => s.id === id);
  }

  /** Every stroke to draw, in drawing order. */
  all(): Stroke[] {
    return [...this.saved, ...this.local];
  }

  /** An own stroke, drawn at once and kept at the end until it is saved. */
  addLocal(stroke: Stroke): void {
    if (!this.has(stroke.id)) this.local.push(stroke);
  }

  /**
   * A saved stroke, from anyone. An own stroke with the same id moves to its
   * place in seq order. Returns false if it was already saved here.
   */
  addSaved(stroke: SavedStroke): boolean {
    if (this.savedIds.has(stroke.id)) return false;
    this.local = this.local.filter((s) => s.id !== stroke.id);

    // Almost always the last one, so search from the end.
    let i = this.saved.length;
    while (i > 0 && (this.saved[i - 1]?.seq ?? 0) > stroke.seq) i--;
    this.saved.splice(i, 0, stroke);
    this.savedIds.add(stroke.id);
    this.seqs.add(stroke.seq);
    while (this.seqs.has(this.contiguous + 1)) this.contiguous++;
    return true;
  }

  /** The server acked an own stroke: it is saved as `seq`. */
  confirm(id: string, seq: number): void {
    const stroke = this.local.find((s) => s.id === id);
    if (stroke) this.addSaved({ ...stroke, seq });
  }

  /**
   * Applies a snapshot of the strokes after `since`. A snapshot from 0
   * replaces every saved stroke; own unsaved strokes stay.
   */
  applySnapshot(since: number, strokes: SavedStroke[]): void {
    if (since === 0) {
      this.saved = [];
      this.savedIds.clear();
      this.seqs.clear();
      this.contiguous = 0;
    }
    for (const stroke of strokes) this.addSaved(stroke);
  }
}
