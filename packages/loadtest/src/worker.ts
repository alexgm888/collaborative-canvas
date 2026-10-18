import { parentPort, workerData } from 'node:worker_threads';
import { Metrics, SimClient } from './sim.js';
import type { Behavior, MetricsData } from './sim.js';

/** What the main thread gives each worker. */
export interface WorkerInput {
  url: string;
  behavior: Behavior;
  clients: { canvasId: string; name: string; delayMs: number }[];
}

export type ToWorker =
  { type: 'start' } | { type: 'stop' } | { type: 'report' } | { type: 'close' };

export interface ClientReport {
  canvasId: string;
  ops: [number, string][];
  ephemeralSent: { cursor: number; livePoints: number };
}

export type FromWorker =
  | { type: 'joined'; failed: string[] }
  | { type: 'progress'; open: number; sent: number; received: number }
  | { type: 'stopped'; unacked: number }
  | {
      type: 'report';
      metrics: MetricsData;
      clients: ClientReport[];
      /** Share of the time this thread was busy while clients were active. */
      utilization: number;
    };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const input = workerData as WorkerInput;
const port = parentPort!;
const post = (message: FromWorker) => port.postMessage(message);

const metrics = new Metrics();
const clients = input.clients.map(
  (c) => new SimClient(input.url, c.canvasId, c.name, metrics, input.behavior),
);
let utilizationStart = performance.eventLoopUtilization();
let utilization = 0;

const sum = (map: Map<string, number>) => [...map.values()].reduce((a, b) => a + b, 0);
const progress = setInterval(() => {
  metrics.prune(30_000);
  post({
    type: 'progress',
    open: clients.filter((c) => c.isOpen).length,
    sent: sum(metrics.sent),
    received: sum(metrics.received),
  });
}, 1000);

// People arrive one after another; activity starts once everybody is in, so
// every run measures the same number of people drawing.
const joins = await Promise.allSettled(
  clients.map(async (client, i) => {
    await sleep(input.clients[i]!.delayMs);
    await client.connect();
  }),
);
post({
  type: 'joined',
  failed: joins.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : [])),
});

port.on('message', async (message: ToWorker) => {
  switch (message.type) {
    case 'start':
      utilizationStart = performance.eventLoopUtilization();
      for (const client of clients) if (client.isOpen) client.start();
      return;
    case 'stop': {
      for (const client of clients) client.stopActivity();
      utilization = performance.eventLoopUtilization(utilizationStart).utilization;
      // Let in-flight operations be acked before the canvases are compared.
      const started = performance.now();
      while (clients.some((c) => c.pending.size > 0) && performance.now() - started < 20_000) {
        await sleep(100);
      }
      post({ type: 'stopped', unacked: clients.reduce((n, c) => n + c.pending.size, 0) });
      return;
    }
    case 'report':
      post({
        type: 'report',
        metrics: metrics.toData(),
        clients: clients.map((c, i) => ({
          canvasId: input.clients[i]!.canvasId,
          ops: [...c.ops],
          ephemeralSent: c.ephemeralSent,
        })),
        utilization,
      });
      return;
    case 'close':
      clearInterval(progress);
      for (const client of clients) client.close();
      // Give the close frames a moment to go out.
      await sleep(200);
      process.exit(0);
  }
});
