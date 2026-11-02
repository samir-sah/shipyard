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

export async function enqueueDeployment(id: string): Promise<void> {
  await queue.add('build', { deploymentId: id }, { jobId: id });
}

export async function dispatchQueued(): Promise<void> {
  const result = await pool.query<{ id: string }>("SELECT id FROM deployments WHERE status = 'queued' ORDER BY created_at LIMIT 100");
  for (const row of result.rows) await enqueueDeployment(row.id);
}
