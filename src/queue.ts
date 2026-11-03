import { Queue } from 'bullmq';
import { config } from './config.js';
import { pool } from './db.js';

const redis = new URL(config.redisUrl);
if (!['redis:', 'rediss:'].includes(redis.protocol)) throw new Error('REDIS_URL must use redis:// or rediss://');
export const connectionOptions = {
  host: redis.hostname,
  port: Number(redis.port || 6379),
  username: redis.username ? decodeURIComponent(redis.username) : undefined,
  password: redis.password ? decodeURIComponent(redis.password) : undefined,
  db: Number(redis.pathname.slice(1) || 0),
  tls: redis.protocol === 'rediss:' ? {} : undefined,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 5_000,
};
export const queueName = 'shipyard-builds';
export const queue = new Queue(queueName, {
  connection: connectionOptions,
  defaultJobOptions: { attempts: 1, removeOnComplete: { age: 86_400, count: 1_000 }, removeOnFail: { age: 604_800, count: 1_000 } },
});
queue.on('error', error => console.error('Build queue error', error));

export async function enqueueDeployment(id: string, targetQueue = queue): Promise<void> {
  const result = await pool.query<{ expected_attempt: number }>("SELECT attempt_count + 1 AS expected_attempt FROM deployments WHERE id = $1 AND status = 'queued' AND retry_at <= clock_timestamp()", [id]);
  if (!result.rowCount) return;
  const expectedAttempt = result.rows[0].expected_attempt;
  const jobId = `${id}-${expectedAttempt}`;
  const existing = await targetQueue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'completed' && state !== 'failed') return;
    await existing.remove();
  }
  await targetQueue.add('build', { deploymentId: id, expectedAttempt }, { jobId });
}

export async function dispatchQueued(targetQueue = queue): Promise<void> {
  const result = await pool.query<{ id: string }>("SELECT id FROM deployments WHERE status = 'queued' AND retry_at <= clock_timestamp() ORDER BY retry_at, created_at LIMIT 100");
  for (const row of result.rows) await enqueueDeployment(row.id, targetQueue);
}
