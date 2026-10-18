import { appendFile, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { Histogram, round } from './histogram.js';
import { LATENCIES } from './sim.js';
import type { Behavior } from './sim.js';
import type { ClientReport, FromWorker, ToWorker, WorkerInput } from './worker.js';

const USAGE = `Load test: simulated people drawing on the same canvases over WebSocket.

  npm run loadtest -- [options]

  --url <url>         Server to test (default http://localhost:3001)
  --clients <n>       Simulated people (default 50)
  --rooms <n>         Canvases they are spread over (default 1)
  --duration <s>      Seconds of activity once everyone is in (default 60)
  --ramp <s>          Seconds over which clients connect (default 10)
  --cursor-hz <n>     Cursor messages per second per person (default 20)
  --pause <ms-ms>     Pause between strokes (default 1000-3000)
  --stroke <ms-ms>    Time spent drawing each stroke (default 500-1500)
  --undo <0-1>        Chance of undoing each stroke (default 0.1)
  --workers <n>       Threads simulating clients (default: CPU cores - 1, at most 4)
  --out <file>        Also write the results as JSON
`;

function range(value: string): [number, number] {
  const [min, max] = value.split('-').map(Number);
  if (!Number.isFinite(min) || !Number.isFinite(max)) throw new Error(`bad range: ${value}`);
  return [min!, max!];
}

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3001' },
    clients: { type: 'string', default: '50' },
    rooms: { type: 'string', default: '1' },
    duration: { type: 'string', default: '60' },
    ramp: { type: 'string', default: '10' },
    'cursor-hz': { type: 'string', default: '20' },
    pause: { type: 'string', default: '1000-3000' },
    stroke: { type: 'string', default: '500-1500' },
    undo: { type: 'string', default: '0.1' },
    workers: { type: 'string', default: String(Math.min(4, availableParallelism() - 1)) },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const config = {
  url: args.url,
  clients: Number(args.clients),
  rooms: Number(args.rooms),
  durationS: Number(args.duration),
  rampS: Number(args.ramp),
  workers: Math.max(1, Number(args.workers)),
};
const behavior: Behavior = {
  cursorHz: Number(args['cursor-hz']),
  pauseMs: range(args.pause),
  strokeMs: range(args.stroke),
  undoRate: Number(args.undo),
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createCanvas(): Promise<string> {
  const res = await fetch(new URL('/api/canvases', config.url), { method: 'POST' });
  if (res.status !== 201) throw new Error(`creating a canvas failed: HTTP ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

/**
 * The operations of a canvas as a client that joins now gets them, or null if
 * it cannot join after a few tries (a saturated link, a restarting server).
 */
async function loadCanvas(canvasId: string): Promise<Map<number, string> | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ops = await loadCanvasOnce(canvasId).catch(() => null);
    if (ops) return ops;
    await sleep(2000 * attempt);
  }
  return null;
}

function loadCanvasOnce(canvasId: string): Promise<Map<number, string>> {
  const url = new URL(`/api/canvases/${canvasId}/ws`, config.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('no snapshot in time'));
    }, 15_000);
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('the verifying client could not connect'));
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as {
        type: string;
        strokes: { seq: number; id: string }[];
        changes: { seq: number; id: string }[];
      };
      if (message.type !== 'snapshot') return;
      clearTimeout(timeout);
      socket.close();
      resolve(new Map([...message.strokes, ...message.changes].map((op) => [op.seq, op.id])));
    };
  });
}

/** Every client must have the very same operations under the very same seqs. */
function checkConsistency(clients: ClientReport[], reference: Map<number, string>): string[] {
  const problems: string[] = [];
  const total = reference.size;
  for (let seq = 1; seq <= total; seq++) {
    if (!reference.has(seq)) problems.push(`the canvas has a gap at seq ${seq}`);
  }
  if (new Set(reference.values()).size !== total) problems.push('an id is saved twice');

  let differing = 0;
  for (const client of clients) {
    const ops = new Map(client.ops);
    const same = ops.size === total && [...reference].every(([seq, id]) => ops.get(seq) === id);
    if (!same) differing++;
  }
  if (differing > 0) problems.push(`${differing} of ${clients.length} clients differ`);
  return problems;
}

/** Starts a thread of simulated clients. */
function spawn(input: WorkerInput, onMessage: (message: FromWorker) => void): Worker {
  // Workers do not inherit tsx's loader from the command line.
  const worker = new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: input,
    execArgv: ['--import', 'tsx'],
  });
  worker.on('message', onMessage);
  worker.on('error', (err) => {
    console.error('Worker failed:', err);
    process.exit(1);
  });
  return worker;
}

/** Resolves when every worker has sent a message of this type. */
function collect<T extends FromWorker['type']>(
  inboxes: FromWorker[][],
  type: T,
): Promise<Extract<FromWorker, { type: T }>[]> {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      const found = inboxes.map((inbox) => inbox.find((m) => m.type === type));
      if (found.every((m) => m !== undefined)) {
        clearInterval(check);
        resolve(found as Extract<FromWorker, { type: T }>[]);
      }
    }, 50);
  });
}

async function main(): Promise<void> {
  const health = await fetch(new URL('/api/health', config.url));
  if (!health.ok) throw new Error(`server not healthy: HTTP ${health.status}`);

  console.log(
    `${config.clients} clients in ${config.rooms} canvas(es) at ${config.url} on ` +
      `${config.workers} threads: ${config.durationS} s, cursor ${behavior.cursorHz} Hz, ` +
      `pause ${behavior.pauseMs.join('-')} ms, stroke ${behavior.strokeMs.join('-')} ms`,
  );

  const canvases: string[] = [];
  for (let i = 0; i < config.rooms; i++) canvases.push(await createCanvas());

  // Client i draws on canvas i % rooms and runs on thread i % workers, so
  // every thread has people from every canvas.
  const inputs: WorkerInput[] = Array.from({ length: config.workers }, () => ({
    url: config.url,
    behavior,
    clients: [],
  }));
  for (let i = 0; i < config.clients; i++) {
    inputs[i % config.workers]!.clients.push({
      canvasId: canvases[i % config.rooms]!,
      name: `Carga ${i + 1}`,
      delayMs: (i / config.clients) * config.rampS * 1000,
    });
  }

  const inboxes: FromWorker[][] = inputs.map(() => []);
  const progress = inputs.map(() => ({ open: 0, sent: 0, received: 0 }));
  const workers = inputs.map((input, w) =>
    spawn(input, (message) => {
      if (message.type === 'progress') progress[w] = message;
      else inboxes[w]!.push(message);
    }),
  );
  const tell = (message: ToWorker) => workers.forEach((w) => w.postMessage(message));

  const joined = await collect(inboxes, 'joined');
  const failed = joined.flatMap((j) => j.failed);
  if (failed.length > 0) console.log(`  ${failed.length} clients could not join: ${failed[0]}`);

  // The server as seen from outside: an HTTP round trip that waits behind
  // whatever the server's event loop is doing (plus one SELECT 1).
  const probe = new Histogram();
  let probing = true;
  const runProbe = async () => {
    while (probing) {
      const started = performance.now();
      // A server that does not answer in 10 s counts as 10 s, and the run goes on.
      await fetch(new URL('/api/health', config.url), {
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
      probe.record(performance.now() - started);
      await sleep(250);
    }
  };

  const started = performance.now();
  const baseline = progress.map((p) => ({ ...p }));
  tell({ type: 'start' });
  const probing$ = runProbe();
  const ticker = setInterval(() => {
    const elapsed = (performance.now() - started) / 1000;
    const total = (key: 'sent' | 'received') =>
      progress.reduce((n, p, w) => n + p[key] - baseline[w]![key], 0);
    console.log(
      `  ${elapsed.toFixed(0).padStart(4)} s  open ${progress.reduce((n, p) => n + p.open, 0)}  ` +
        `out ${Math.round(total('sent') / elapsed)}/s  in ${Math.round(total('received') / elapsed)}/s  ` +
        `server probe p95 ${probe.percentile(95)} ms`,
    );
  }, 5000);

  await sleep(config.durationS * 1000);
  const activeS = (performance.now() - started) / 1000;
  clearInterval(ticker);
  probing = false;
  await probing$;
  tell({ type: 'stop' });
  const stopped = await collect(inboxes, 'stopped');
  // Broadcasts of the last acked operations may still be on their way.
  await sleep(1000);
  tell({ type: 'report' });
  const reports = await collect(inboxes, 'report');

  // Merge what every thread measured.
  const latency = Object.fromEntries(LATENCIES.map((name) => [name, new Histogram()]));
  const sent = new Map<string, number>();
  const received = new Map<string, number>();
  const errors = new Map<string, number>();
  let bytesOut = 0;
  let bytesIn = 0;
  let unexpectedCloses = 0;
  let livePointsReceived = 0;
  const add = (map: Map<string, number>, record: Record<string, number>) => {
    for (const [k, v] of Object.entries(record)) map.set(k, (map.get(k) ?? 0) + v);
  };
  for (const { metrics } of reports) {
    for (const name of LATENCIES) latency[name]!.merge(metrics.latency[name]);
    add(sent, metrics.sent);
    add(received, metrics.received);
    add(errors, metrics.errors);
    bytesOut += metrics.bytesOut;
    bytesIn += metrics.bytesIn;
    unexpectedCloses += metrics.unexpectedCloses;
    livePointsReceived += metrics.livePointsReceived;
  }

  const problems: string[] = [];
  const unacked = stopped.reduce((n, s) => n + s.unacked, 0);
  if (unacked > 0) problems.push(`${unacked} operations never acked`);
  const clients = reports.flatMap((r) => r.clients);
  // Every report is in: close the simulated clients first, so their traffic
  // does not crowd out the verifying client on a slow link.
  tell({ type: 'close' });
  await sleep(500);
  // Deliveries a server that dropped and merged nothing would make: each
  // cursor and live point to everyone else in its canvas.
  const expected = { cursor: 0, livePoints: 0 };
  for (const canvasId of canvases) {
    const inRoom = clients.filter((c) => c.canvasId === canvasId);
    for (const c of inRoom) {
      expected.cursor += c.ephemeralSent.cursor * (inRoom.length - 1);
      expected.livePoints += c.ephemeralSent.livePoints * (inRoom.length - 1);
    }
    const reference = await loadCanvas(canvasId);
    if (!reference) {
      problems.push(`${canvasId}: could not load the canvas to check it`);
      continue;
    }
    problems.push(...checkConsistency(inRoom, reference).map((p) => `${canvasId}: ${p}`));
  }

  // Messages inside batches are counted apart ("batch.cursor"), not as frames.
  const total = (map: Map<string, number>) =>
    [...map].reduce((n, [key, count]) => (key.includes('.') ? n : n + count), 0);
  const ratio = (got: number, wanted: number) => (wanted === 0 ? 1 : got / wanted);
  const results = {
    config: { ...config, behavior },
    joinedClients: config.clients - failed.length,
    seconds: round(activeS),
    latencyMs: {
      ...Object.fromEntries(LATENCIES.map((name) => [name, latency[name]!.summary()])),
      serverProbe: probe.summary(),
    },
    throughput: {
      sentPerS: Math.round(total(sent) / activeS),
      receivedPerS: Math.round(total(received) / activeS),
      kbOutPerS: round(bytesOut / 1024 / activeS),
      kbInPerS: round(bytesIn / 1024 / activeS),
      sent: Object.fromEntries(sent),
      received: Object.fromEntries(received),
    },
    ephemeralDelivered: {
      // Below 1 by design once the server batches: only the latest cursor of
      // each peer per interval is sent.
      cursor: round(ratio(received.get('batch.cursor') ?? 0, expected.cursor), 4),
      // Every point should arrive unless the server or a slow client drops it.
      livePoints: round(ratio(livePointsReceived, expected.livePoints), 4),
    },
    generatorThreadUtilization: reports.map((r) => round(r.utilization, 2)),
    unexpectedCloses,
    errors: Object.fromEntries(errors),
    consistency: problems.length === 0 ? 'ok' : problems,
  };

  console.log('\nLatency (ms)        count      p50      p95      p99      max');
  for (const [name, s] of Object.entries(results.latencyMs)) {
    console.log(
      `  ${name.padEnd(16)}${String(s.count).padStart(8)}` +
        [s.p50, s.p95, s.p99, s.max].map((v) => String(v).padStart(9)).join(''),
    );
  }
  console.log(`\nThroughput  ${JSON.stringify(results.throughput)}`);
  console.log(`Ephemeral delivered  ${JSON.stringify(results.ephemeralDelivered)}`);
  console.log(`Generator threads busy  ${JSON.stringify(results.generatorThreadUtilization)}`);
  if (errors.size > 0) console.log(`Errors  ${JSON.stringify(results.errors)}`);
  console.log(
    problems.length === 0
      ? 'Consistency  ok: every client has the same operations as a newcomer, gapless'
      : `Consistency  FAILED\n  ${problems.join('\n  ')}`,
  );

  // npm runs this from the package folder; paths are relative to where it was called.
  if (args.out)
    await writeFile(
      resolve(process.env.INIT_CWD ?? '.', args.out),
      JSON.stringify(results, null, 2) + '\n',
    );

  // On GitHub Actions, the same table shows on the run's page.
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    const rows = Object.entries(results.latencyMs).map(
      ([name, s]) => `| ${name} | ${s.count} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} |`,
    );
    const summary = [
      `## Load test: ${config.clients} clients, ${config.rooms} canvas(es), ${config.durationS} s`,
      '',
      `Server: ${config.url}`,
      '',
      '| Latency (ms) | count | p50 | p95 | p99 | max |',
      '| --- | --: | --: | --: | --: | --: |',
      ...rows,
      '',
      `- Received: ${results.throughput.receivedPerS} messages/s, ${results.throughput.kbInPerS} KB/s`,
      `- Ephemeral delivered: ${JSON.stringify(results.ephemeralDelivered)}`,
      `- Generator threads busy: ${JSON.stringify(results.generatorThreadUtilization)}`,
      `- Consistency: ${problems.length === 0 ? 'ok' : problems.join('; ')}`,
      '',
    ].join('\n');
    await appendFile(summaryFile, summary);
  }
  process.exitCode = problems.length === 0 && unexpectedCloses === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
