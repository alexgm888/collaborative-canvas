import type { SavedStroke, SavedVisibility, Stroke, Visibility } from '@canvas/shared';

/**
 * The strokes of a canvas as this client knows them: the saved ones in seq
 * order, then its own strokes that are not saved (waiting for an ack, or
 * rejected). Every client draws saved strokes in the same order, whatever
 * order they arrived in.
 *
 * Undo and redo are visibility changes, not deletions. A hidden stroke keeps
 * its place, so redo shows it where it was, under whatever was drawn later.
 * The saved change with the highest seq decides; own unsaved changes apply on
 * top, since they will be saved after every change already here.
 *
 * `lastSeq` is the highest seq up to which every operation (stroke or change)
 * is here. It is what a reconnection asks to resume from. It is not simply the
 * highest seq seen: operations saved at the same time can arrive out of order,
 * and with 5 and 7 here but not 6, resuming from 7 would lose 6 for good.
 */
export class StrokeLog {
  private saved: SavedStroke[] = [];
  private readonly savedIds = new Set<string>();
  private readonly seqs = new Set<number>();
  private local: Stroke[] = [];
  private contiguous = 0;
  /** The latest saved change of each stroke, by stroke id. */
  private readonly visibility = new Map<string, SavedVisibility>();
  private readonly changeIds = new Set<string>();
  private localChanges: Visibility[] = [];

  get lastSeq(): number {
    return this.contiguous;
  }

  has(id: string): boolean {
    return this.savedIds.has(id) || this.local.some((s) => s.id === id);
  }

  isVisible(strokeId: string): boolean {
    for (let i = this.localChanges.length - 1; i >= 0; i--) {
      const change = this.localChanges[i];
      if (change?.strokeId === strokeId) return change.visible;
    }
    return this.visibility.get(strokeId)?.visible ?? true;
  }

  /** Every stroke to draw, in drawing order. */
  all(): Stroke[] {
    return [...this.saved, ...this.local].filter((s) => this.isVisible(s.id));
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
    this.addSeq(stroke.seq);
    return true;
  }

  /** An own undo or redo, applied at once until it is saved. */
  addLocalChange(change: Visibility): void {
    this.localChanges.push(change);
  }

  /**
   * A saved change, from anyone. It may arrive before the stroke it changes,
   * which then appears with it applied. Returns false if it was already here.
   */
  addSavedChange(change: SavedVisibility): boolean {
    if (this.changeIds.has(change.id)) return false;
    this.localChanges = this.localChanges.filter((c) => c.id !== change.id);
    this.changeIds.add(change.id);
    const current = this.visibility.get(change.strokeId);
    if (!current || current.seq < change.seq) this.visibility.set(change.strokeId, change);
    this.addSeq(change.seq);
    return true;
  }

  /** The server refused an own change: the stroke goes back to how it was. */
  dropLocalChange(id: string): Visibility | undefined {
    const change = this.localChanges.find((c) => c.id === id);
    this.localChanges = this.localChanges.filter((c) => c.id !== id);
    return change;
  }

  /** The server acked an own stroke or change: it is saved as `seq`. */
  confirm(id: string, seq: number): void {
    const stroke = this.local.find((s) => s.id === id);
    if (stroke) this.addSaved({ ...stroke, seq });
    const change = this.localChanges.find((c) => c.id === id);
    if (change) this.addSavedChange({ ...change, seq });
  }

  /**
   * Applies a snapshot of the operations after `since`. A snapshot from 0
   * replaces everything saved; own unsaved strokes and changes stay.
   */
  applySnapshot(since: number, strokes: SavedStroke[], changes: SavedVisibility[]): void {
    if (since === 0) {
      this.saved = [];
      this.savedIds.clear();
      this.seqs.clear();
      this.visibility.clear();
      this.changeIds.clear();
      this.contiguous = 0;
    }
    for (const stroke of strokes) this.addSaved(stroke);
    for (const change of changes) this.addSavedChange(change);
  }

  private addSeq(seq: number): void {
    this.seqs.add(seq);
    while (this.seqs.has(this.contiguous + 1)) this.contiguous++;
  }
}
