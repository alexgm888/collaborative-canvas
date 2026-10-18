/// <reference types="node" />
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SavedStroke, Stroke } from '@canvas/shared';
import { StrokeLog } from './strokeLog';

function stroke(n: number): Stroke {
  return { id: `id-${n}`, color: '#2563eb', width: 4, points: [{ x: n, y: n }] };
}

function saved(n: number, seq = n): SavedStroke {
  return { ...stroke(n), seq };
}

const ids = (log: StrokeLog) => log.all().map((s) => s.id);

describe('StrokeLog', () => {
  it('draws saved strokes in seq order, whatever order they arrive in', () => {
    const log = new StrokeLog();
    log.addSaved(saved(2));
    log.addSaved(saved(3));
    log.addSaved(saved(1));

    assert.deepEqual(ids(log), ['id-1', 'id-2', 'id-3']);
  });

  it('only advances lastSeq while there are no gaps', () => {
    const log = new StrokeLog();
    log.addSaved(saved(1));
    log.addSaved(saved(3));
    assert.equal(log.lastSeq, 1, 'seq 2 is still missing');

    log.addSaved(saved(2));
    assert.equal(log.lastSeq, 3);
  });

  it('keeps own unsaved strokes last and moves them into place when acked', () => {
    const log = new StrokeLog();
    log.addSaved(saved(1));
    log.addLocal(stroke(9));
    log.addSaved(saved(2));
    assert.deepEqual(ids(log), ['id-1', 'id-2', 'id-9']);

    // Someone else's stroke saved later arrives before the ack.
    log.addSaved(saved(4));
    log.confirm('id-9', 3);
    assert.deepEqual(ids(log), ['id-1', 'id-2', 'id-9', 'id-4']);
    assert.equal(log.lastSeq, 4);
  });

  it('ignores a stroke it already has', () => {
    const log = new StrokeLog();
    assert.equal(log.addSaved(saved(1)), true);
    assert.equal(log.addSaved(saved(1)), false);
    log.addLocal(stroke(1));

    assert.deepEqual(ids(log), ['id-1']);
  });

  it('merges a snapshot after `since` with what it already has', () => {
    const log = new StrokeLog();
    log.addSaved(saved(1));
    log.addSaved(saved(3));
    log.addLocal(stroke(9));

    log.applySnapshot(1, [saved(2), saved(3), saved(4)]);

    assert.deepEqual(ids(log), ['id-1', 'id-2', 'id-3', 'id-4', 'id-9']);
    assert.equal(log.lastSeq, 4);
  });

  it('replaces saved strokes with a snapshot from 0 but keeps unsaved ones', () => {
    const log = new StrokeLog();
    log.addSaved(saved(1));
    log.addSaved(saved(2));
    log.addLocal(stroke(9));

    log.applySnapshot(0, [saved(5, 1)]);

    assert.deepEqual(ids(log), ['id-5', 'id-9']);
    assert.equal(log.lastSeq, 1);
  });
});
