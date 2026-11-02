import { Worker } from 'bullmq';
import { config } from './config.js';
import { pool, migrate, appendLog, claimDeployment, activateDeployment, failDeployment } from './db.js';
import { connectionOptions, queueName, queue, dispatchQueued } from './queue.js';
import { ensureBucket, uploadArtifacts, s3 } from './storage.js';
import { buildRepository } from './build.js';
import { requireUuid } from './validation.js';

async function deploy(id: string): Promise<void> {
  const repoUrl = await claimDeployment(id);
  if (!repoUrl) return;
  let pendingLogs = Promise.resolve();
  let bytes = 0;
  const log = (stream: 'stdout' | 'stderr' | 'system', message: string) => {
    if (bytes > config.maxLogBytes) return;
    bytes += Buffer.byteLength(message);
    pendingLogs = pendingLogs.then(() => appendLog(id, stream, message));
    // Attach a handler immediately; the awaited chain still reports persistence failures below.
    void pendingLogs.catch(() => {});
  };
  try {
    let commitSha = '';
    await buildRepository(id, repoUrl, log, async (directory, sha, signal) => {
      await uploadArtifacts(id, directory, signal);
      commitSha = sha;
    });
    await pendingLogs;
    if (!await activateDeployment(id, commitSha)) throw new Error('Deployment is no longer building');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pendingLogs.catch(logError => console.error('Could not persist build logs', logError));
    await failDeployment(id, message);
    await appendLog(id, 'system', `Deployment failed: ${message}\n`).catch(console.error);
    throw error;
  }
  await appendLog(id, 'system', 'Deployment is live.\n').catch(error => console.error('Could not persist completion log', error));
}

await migrate();
await ensureBucket();
const worker = new Worker(queueName, async job => {
  const id = job.data?.deploymentId;
  if (typeof id !== 'string') throw new Error('Invalid deployment job');
  await deploy(requireUuid(id));
}, {
  connection: { ...connectionOptions, maxRetriesPerRequest: null, enableOfflineQueue: true },
  concurrency: config.workerConcurrency,
  maxStalledCount: 0,
});
worker.on('error', error => console.error('Worker error', error));
worker.on('failed', (job, error) => console.error(`Deployment ${job?.id} failed`, error.message));
let dispatching = false;
async function dispatch(): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try { await dispatchQueued(); }
  catch (error) { console.error('Queue dispatch failed; retrying in five seconds', error); }
  finally { dispatching = false; }
}
await dispatch();
const timer = setInterval(() => { void dispatch(); }, 5_000);
console.log(`Worker ready: concurrency=${config.workerConcurrency}, cpus=${config.buildCpus}, memory=${config.buildMemoryMb} MiB, timeout=${config.buildTimeoutMs} ms`);
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(timer);
  await worker.close();
  await queue.close();
  await pool.end();
  s3.destroy();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown().catch(error => { console.error(error); process.exitCode = 1; }); });
