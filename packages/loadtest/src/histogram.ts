// Latencies are counted in buckets of 0.1 ms up to a minute instead of being
// kept one by one: a run records millions of deliveries, and a fixed-size
// histogram gives exact enough percentiles in constant memory.
const BUCKET_MS = 0.1;
const MAX_MS = 60_000;

/** What a histogram is made of, to send it between threads. */
export interface HistogramData {
  buckets: Uint32Array;
  count: number;
  max: number;
  sum: number;
}

export class Histogram {
  private readonly buckets = new Uint32Array(MAX_MS / BUCKET_MS + 1);
  count = 0;
  max = 0;
  private sum = 0;

  toData(): HistogramData {
    return { buckets: this.buckets, count: this.count, max: this.max, sum: this.sum };
  }

  /** Adds the values recorded by another histogram, in another thread for instance. */
  merge(data: HistogramData): void {
    for (let i = 0; i < this.buckets.length; i++) this.buckets[i]! += data.buckets[i]!;
    this.count += data.count;
    this.sum += data.sum;
    this.max = Math.max(this.max, data.max);
  }

  record(ms: number): void {
    const value = Math.max(0, ms);
    const index = Math.min(this.buckets.length - 1, Math.round(value / BUCKET_MS));
    this.buckets[index]!++;
    this.count++;
    this.sum += value;
    if (value > this.max) this.max = value;
  }

  get mean(): number {
    return this.count === 0 ? 0 : this.sum / this.count;
  }

  /** The value below which `p` percent of the recorded values fall. */
  percentile(p: number): number {
    if (this.count === 0) return 0;
    const rank = Math.max(1, Math.ceil((p / 100) * this.count));
    let seen = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      seen += this.buckets[i]!;
      if (seen >= rank) return round(i * BUCKET_MS);
    }
    return MAX_MS;
  }

  summary() {
    return {
      count: this.count,
      mean: round(this.mean),
      p50: round(this.percentile(50)),
      p95: round(this.percentile(95)),
      p99: round(this.percentile(99)),
      max: round(this.max),
    };
  }
}

export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
