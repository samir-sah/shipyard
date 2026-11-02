import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config } from './config.js';
import type { DeploymentLog } from './contracts.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
pool.on('error', error => console.error('PostgreSQL pool error', error));

export const projectColumns = `id, name, slug, repo_url AS "repoUrl", branch, active_deployment_id AS "activeDeploymentId", created_at AS "createdAt"`;
export const deploymentColumns = `id, project_id AS "projectId", status, commit_sha AS "commitSha", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt", error, log_truncated AS "logTruncated", CASE WHEN started_at IS NULL THEN NULL ELSE (extract(epoch FROM (started_at - created_at)) * 1000)::float8 END AS "queueWaitMs", CASE WHEN finished_at IS NULL OR started_at IS NULL THEN NULL ELSE (extract(epoch FROM (finished_at - started_at)) * 1000)::float8 END AS "buildDurationMs"`;

export async function migrate(): Promise<void> {
  const sql = await readFile(resolve('migrations/001_initial.sql'), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(190882)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const result = await client.query('SELECT 1 FROM schema_migrations WHERE version = 1');
    if (!result.rowCount) {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES (1)');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function appendLog(deploymentId: string, stream: DeploymentLog['stream'], message: string): Promise<void> {
  if (!message) return;
  message = message.replaceAll('\0', '\uFFFD');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{ log_bytes: number }>('SELECT log_bytes FROM deployments WHERE id = $1 FOR UPDATE', [deploymentId]);
    if (!row.rowCount) throw new Error('Deployment does not exist');
    const remaining = Math.max(0, config.maxLogBytes - row.rows[0].log_bytes);
    let clipped = Buffer.from(message).subarray(0, remaining).toString('utf8');
    while (Buffer.byteLength(clipped) > remaining) clipped = clipped.slice(0, -1);
    const size = Buffer.byteLength(clipped);
    if (size) await client.query('INSERT INTO deployment_logs(deployment_id, stream, message) VALUES ($1, $2, $3)', [deploymentId, stream, clipped]);
    await client.query('UPDATE deployments SET log_bytes = log_bytes + $2, log_truncated = log_truncated OR $3 WHERE id = $1', [deploymentId, size, size < Buffer.byteLength(message)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function claimDeployment(id: string): Promise<string | null> {
  const result = await pool.query<{ repo_url: string }>(
    `UPDATE deployments d SET status = 'building', started_at = now()
     FROM projects p WHERE d.id = $1 AND d.project_id = p.id AND d.status = 'queued'
     RETURNING p.repo_url`, [id],
  );
  return result.rows[0]?.repo_url ?? null;
}

export async function failDeployment(id: string, error: string): Promise<boolean> {
  const result = await pool.query("UPDATE deployments SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'building'", [id, error.slice(0, 2_000)]);
  return result.rowCount === 1;
}

export async function activateDeployment(id: string, commitSha: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ project_id: string }>("UPDATE deployments SET status = 'deployed', commit_sha = $2, finished_at = now() WHERE id = $1 AND status = 'building' RETURNING project_id", [id, commitSha]);
    if (result.rowCount) await client.query('UPDATE projects SET active_deployment_id = $2 WHERE id = $1', [result.rows[0].project_id, id]);
    await client.query('COMMIT');
    return result.rowCount === 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
