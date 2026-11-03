import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from './config.js';
import type { ArtifactManifest, Deployment, DeploymentClaim, DeploymentLog, Project } from './contracts.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
pool.on('error', error => console.error('PostgreSQL pool error', error));

export const projectColumns = `id, name, slug, repo_url AS "repoUrl", branch, active_deployment_id AS "activeDeploymentId", created_at AS "createdAt"`;
export const deploymentColumns = `id, project_id AS "projectId", status, commit_sha AS "commitSha", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt", error, log_truncated AS "logTruncated", attempt_count AS "attemptCount", CASE WHEN started_at IS NULL THEN NULL ELSE (extract(epoch FROM (started_at - created_at)) * 1000)::float8 END AS "queueWaitMs", CASE WHEN finished_at IS NULL OR started_at IS NULL THEN NULL ELSE (extract(epoch FROM (finished_at - started_at)) * 1000)::float8 END AS "buildDurationMs"`;

async function transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function migrate(): Promise<void> {
  const files = (await readdir(resolve('migrations'))).filter(file => /^\d{3}_.*\.sql$/.test(file)).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(190882)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    for (const file of files) {
      const version = Number(file.slice(0, 3));
      const result = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (!result.rowCount) {
        await client.query(await readFile(resolve('migrations', file), 'utf8'));
        await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function appendLog(deploymentId: string, stream: DeploymentLog['stream'], message: string, token?: string): Promise<void> {
  if (!message) return;
  message = message.replaceAll('\0', '\uFFFD');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query<{ log_bytes: number }>('SELECT log_bytes FROM deployments WHERE id = $1 FOR UPDATE', [deploymentId]);
    if (!row.rowCount && !token) throw new Error('Deployment does not exist');
    if (token) {
      const active = await client.query("SELECT 1 FROM deployments WHERE id = $1 AND claim_token = $2 AND status = 'building' AND lease_expires_at > clock_timestamp()", [deploymentId, token]);
      if (!active.rowCount) { await client.query('COMMIT'); return; }
    }
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

export async function claimDeployment(id: string, expectedAttempt: number): Promise<DeploymentClaim | null> {
  if (!Number.isSafeInteger(expectedAttempt) || expectedAttempt < 1) return null;
  return transaction(async client => {
    await client.query('SELECT id FROM deployments WHERE id = $1 FOR UPDATE', [id]);
    const token = randomUUID();
    const result = await client.query<{ repo_url: string; attempt_count: number; commit_sha: string | null }>(
      `UPDATE deployments d SET status = 'building', started_at = coalesce(d.started_at, clock_timestamp()),
         finished_at = NULL, error = NULL, claim_token = $2,
         lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond', attempt_count = d.attempt_count + 1
       FROM projects p WHERE d.id = $1 AND d.project_id = p.id AND d.status = 'queued'
         AND d.retry_at <= clock_timestamp() AND d.attempt_count + 1 = $4 AND d.attempt_count < $5
       RETURNING p.repo_url, d.attempt_count, d.commit_sha`, [id, token, config.workerLeaseMs, expectedAttempt, config.maxBuildAttempts],
    );
    const row = result.rows[0];
    if (!row) return null;
    await client.query("INSERT INTO build_attempts(token, deployment_id, attempt_number, status) VALUES ($1, $2, $3, 'building')", [token, id, row.attempt_count]);
    return { deploymentId: id, token, repoUrl: row.repo_url, attempt: row.attempt_count, commitSha: row.commit_sha };
  });
}

export async function renewClaim(id: string, token: string): Promise<boolean> {
  return transaction(async client => {
    await client.query('SELECT id FROM deployments WHERE id = $1 FOR UPDATE', [id]);
    const result = await client.query("UPDATE deployments SET lease_expires_at = clock_timestamp() + $3 * interval '1 millisecond' WHERE id = $1 AND claim_token = $2 AND status = 'building' AND lease_expires_at > clock_timestamp()", [id, token, config.workerLeaseMs]);
    return result.rowCount === 1;
  });
}

export async function recordDeploymentCommit(id: string, token: string, commitSha: string): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/.test(commitSha)) return false;
  return transaction(async client => {
    await client.query('SELECT id FROM deployments WHERE id = $1 FOR UPDATE', [id]);
    const result = await client.query("UPDATE deployments SET commit_sha = coalesce(commit_sha, $3) WHERE id = $1 AND claim_token = $2 AND status = 'building' AND lease_expires_at > clock_timestamp() AND (commit_sha IS NULL OR commit_sha = $3)", [id, token, commitSha]);
    return result.rowCount === 1;
  });
}

async function finishFailedAttempt(client: pg.PoolClient, id: string, token: string, attempt: number, error: string, status: 'failed' | 'expired'): Promise<'retry' | 'failed'> {
  const retry = attempt < config.maxBuildAttempts;
  const delaySeconds = Math.min(60, 2 ** (attempt - 1));
  const message = error.replaceAll('\0', '\uFFFD').slice(0, 2_000);
  await client.query('UPDATE build_attempts SET status = $2, finished_at = clock_timestamp(), error = $3 WHERE token = $1 AND status = \'building\'', [token, status, message]);
  await client.query("UPDATE deployments SET status = $3, finished_at = CASE WHEN $4::boolean THEN NULL ELSE clock_timestamp() END, retry_at = clock_timestamp() + $5 * interval '1 second', error = $6, claim_token = NULL, lease_expires_at = NULL WHERE id = $1 AND claim_token = $2", [id, token, retry ? 'queued' : 'failed', retry, delaySeconds, message]);
  return retry ? 'retry' : 'failed';
}

export async function failDeployment(id: string, token: string, error: string): Promise<'retry' | 'failed' | null> {
  return transaction(async client => {
    await client.query('SELECT id FROM deployments WHERE id = $1 FOR UPDATE', [id]);
    const result = await client.query<{ attempt_count: number }>("SELECT attempt_count FROM deployments WHERE id = $1 AND claim_token = $2 AND status = 'building' AND lease_expires_at > clock_timestamp()", [id, token]);
    if (!result.rowCount) return null;
    return finishFailedAttempt(client, id, token, result.rows[0].attempt_count, error, 'failed');
  });
}

export async function recoverExpiredClaims(): Promise<number> {
  return transaction(async client => {
    const result = await client.query<{ id: string; claim_token: string; attempt_count: number }>("SELECT id, claim_token, attempt_count FROM deployments WHERE status = 'building' AND lease_expires_at <= clock_timestamp() ORDER BY lease_expires_at LIMIT 100 FOR UPDATE SKIP LOCKED");
    for (const row of result.rows) await finishFailedAttempt(client, row.id, row.claim_token, row.attempt_count, 'Worker claim expired', 'expired');
    const exhausted = await client.query(
      `WITH exhausted AS (
         SELECT id FROM deployments WHERE status = 'queued' AND retry_at <= clock_timestamp() AND attempt_count >= $1
         ORDER BY retry_at, created_at LIMIT $2 FOR UPDATE SKIP LOCKED
       ) UPDATE deployments d SET status = 'failed', finished_at = clock_timestamp(), claim_token = NULL, lease_expires_at = NULL,
         error = left(concat_ws(E'\\n', nullif(d.error, ''), 'Build attempt limit reached before retry'), 2000)
       FROM exhausted WHERE d.id = exhausted.id RETURNING d.id`, [config.maxBuildAttempts, 100 - result.rows.length],
    );
    return result.rows.length + exhausted.rows.length;
  });
}

export async function isClaimActive(token: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM deployments WHERE claim_token = $1 AND status = 'building' AND lease_expires_at > clock_timestamp()", [token]);
  return result.rowCount === 1;
}

export async function listAbandonedAttempts(limit = 100): Promise<Array<{ deploymentId: string; token: string }>> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Cleanup limit must be a positive integer');
  const result = await pool.query<{ deploymentId: string; token: string }>(
    `SELECT a.deployment_id AS "deploymentId", a.token FROM build_attempts a JOIN deployments d ON d.id = a.deployment_id
     WHERE a.status IN ('failed', 'expired') AND a.finished_at <= clock_timestamp()
       AND d.claim_token IS DISTINCT FROM a.token AND coalesce(d.artifact_manifest->>'attemptId', '') <> a.token::text
       AND (a.last_cleanup_at IS NULL OR a.last_cleanup_at <= clock_timestamp() - interval '60 seconds')
     ORDER BY a.last_cleanup_at NULLS FIRST, a.finished_at, a.token LIMIT $1`, [Math.min(limit, 100)],
  );
  return result.rows;
}

export async function markAttemptCleaned(token: string): Promise<void> {
  await pool.query("UPDATE build_attempts SET last_cleanup_at = clock_timestamp() WHERE token = $1 AND status IN ('failed', 'expired')", [token]);
}

export async function createDeployment(projectId: string): Promise<Deployment | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (!project.rowCount) { await client.query('COMMIT'); return null; }
    const generation = await client.query<{ publish_generation: string }>('UPDATE projects SET publish_generation = publish_generation + 1 WHERE id = $1 RETURNING publish_generation', [projectId]);
    const result = await client.query<Deployment>(`INSERT INTO deployments(id, project_id, publish_generation) VALUES ($1, $2, $3) RETURNING ${deploymentColumns}`, [randomUUID(), projectId, generation.rows[0].publish_generation]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function activateDeployment(id: string, token: string, commitSha: string, manifest: ArtifactManifest): Promise<'active' | 'superseded' | null> {
  if (manifest.deploymentId !== id) throw new Error('Artifact manifest belongs to a different deployment');
  if (manifest.attemptId !== token || manifest.commitSha !== commitSha) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query<{ id: string }>('SELECT p.id FROM projects p JOIN deployments d ON d.project_id = p.id WHERE d.id = $1 FOR UPDATE OF p', [id]);
    if (!project.rowCount) { await client.query('COMMIT'); return null; }
    await client.query('SELECT id FROM deployments WHERE id = $1 FOR UPDATE', [id]);
    const result = await client.query<{ publish_generation: string }>("UPDATE deployments SET status = 'deployed', artifact_manifest = $4::jsonb, finished_at = clock_timestamp(), claim_token = NULL, lease_expires_at = NULL WHERE id = $1 AND status = 'building' AND claim_token = $2 AND lease_expires_at > clock_timestamp() AND commit_sha = $3 RETURNING publish_generation", [id, token, commitSha, JSON.stringify(manifest)]);
    if (!result.rowCount) { await client.query('COMMIT'); return null; }
    await client.query("UPDATE build_attempts SET status = 'completed', finished_at = clock_timestamp() WHERE token = $1 AND status = 'building'", [token]);
    const active = await client.query('UPDATE projects SET active_deployment_id = $2 WHERE id = $1 AND publish_generation = $3', [project.rows[0].id, id, result.rows[0].publish_generation]);
    await client.query('COMMIT');
    return active.rowCount ? 'active' : 'superseded';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function rollbackDeployment(projectId: string, deploymentId: string, manifest: ArtifactManifest): Promise<Project | null> {
  if (manifest.deploymentId !== deploymentId) throw new Error('Artifact manifest belongs to a different deployment');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
    if (!project.rowCount) { await client.query('COMMIT'); return null; }
    const target = await client.query("SELECT id FROM deployments WHERE id = $1 AND project_id = $2 AND status = 'deployed' AND (artifact_manifest IS NULL OR artifact_manifest = $3::jsonb) FOR UPDATE", [deploymentId, projectId, JSON.stringify(manifest)]);
    if (!target.rowCount) { await client.query('COMMIT'); return null; }
    await client.query('UPDATE deployments SET artifact_manifest = coalesce(artifact_manifest, $2::jsonb) WHERE id = $1', [deploymentId, JSON.stringify(manifest)]);
    const result = await client.query<Project>(`UPDATE projects SET publish_generation = publish_generation + 1, active_deployment_id = $2 WHERE id = $1 RETURNING ${projectColumns}`, [projectId, deploymentId]);
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
