import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Histogram } from './histogram.js';

describe('Histogram', () => {
  it('reports percentiles to the nearest 0.1 ms', () => {
    const h = new Histogram();
    for (let ms = 1; ms <= 100; ms++) h.record(ms);
    assert.equal(h.count, 100);
    assert.equal(h.percentile(50), 50);
    assert.equal(h.percentile(95), 95);
    assert.equal(h.percentile(100), 100);
    assert.equal(h.mean, 50.5);
    assert.equal(h.max, 100);
  });

  it('keeps sub-millisecond values and clamps the extremes', () => {
    const h = new Histogram();
    h.record(0.34);
    h.record(-5);
    h.record(10 * 60_000);
    assert.equal(h.percentile(1), 0);
    assert.equal(h.percentile(50), 0.3);
    assert.equal(h.percentile(100), 60_000);
  });

  it('merges what other histograms recorded', () => {
    const a = new Histogram();
    const b = new Histogram();
    a.record(10);
    b.record(20);
    b.record(30);
    a.merge(b.toData());
    assert.deepEqual(a.summary(), { count: 3, mean: 20, p50: 20, p95: 30, p99: 30, max: 30 });
  });

  it('is all zeros when empty', () => {
    assert.deepEqual(new Histogram().summary(), {
      count: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });
  });
});
