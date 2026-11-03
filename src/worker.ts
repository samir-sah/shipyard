import { Worker } from 'bullmq';
import { config } from './config.js';
import { pool, migrate, recoverExpiredClaims } from './db.js';
import { connectionOptions, queueName, queue, dispatchQueued } from './queue.js';
import { ensureBucket, s3 } from './storage.js';
import { requireUuid } from './validation.js';
import { deploy } from './deployment.js';
import { cleanupBuildResources, cleanupRetainedArtifacts } from './cleanup.js';

await migrate();
await ensureBucket();
const worker = new Worker(queueName, async job => {
  const { deploymentId, expectedAttempt } = job.data ?? {};
  if (typeof deploymentId !== 'string' || !Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1) throw new Error('Invalid deployment job');
  await deploy(requireUuid(deploymentId), expectedAttempt);
}, {
  connection: { ...connectionOptions, maxRetriesPerRequest: null, enableOfflineQueue: true },
  concurrency: config.workerConcurrency,
  maxStalledCount: 0,
});
worker.on('error', error => console.error('Worker error', error));
worker.on('failed', (job, error) => console.error(`Deployment attempt ${job?.id} failed`, error.message));
let dispatching: Promise<void> | undefined;
function dispatch(): Promise<void> {
  if (dispatching) return dispatching;
  dispatching = (async () => {
    await recoverExpiredClaims();
    await dispatchQueued();
  })().catch(error => console.error('Recovery/dispatch failed; retrying in five seconds', error)).finally(() => { dispatching = undefined; });
  return dispatching;
}
const cleanupController = new AbortController();
let cleaning: Promise<void> | undefined;
function clean(): Promise<void> {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    await cleanupBuildResources(cleanupController.signal);
    await cleanupRetainedArtifacts(cleanupController.signal);
  })().catch(error => { if (!cleanupController.signal.aborted) console.error('Cleanup failed', error); }).finally(() => { cleaning = undefined; });
  return cleaning;
}
await dispatch();
void clean();
const timer = setInterval(() => { void dispatch(); }, 5_000);
const cleanupTimer = setInterval(() => { void clean(); }, 60_000);
console.log(`Worker ready: concurrency=${config.workerConcurrency}, cpus=${config.buildCpus}, memory=${config.buildMemoryMb} MiB, timeout=${config.buildTimeoutMs} ms, lease=${config.workerLeaseMs} ms, maxAttempts=${config.maxBuildAttempts}`);
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  clearInterval(cleanupTimer);
  cleanupController.abort(new Error('Worker shutting down'));
  await Promise.all([worker.close(), dispatching, cleaning]);
  await queue.close();
  await pool.end();
  s3.destroy();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
