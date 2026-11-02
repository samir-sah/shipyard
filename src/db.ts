import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from './config.js';
import type { ArtifactManifest, Deployment, DeploymentLog, Project } from './contracts.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
pool.on('error', error => console.error('PostgreSQL pool error', error));

export const projectColumns = `id, name, slug, repo_url AS "repoUrl", branch, active_deployment_id AS "activeDeploymentId", created_at AS "createdAt"`;
export const deploymentColumns = `id, project_id AS "projectId", status, commit_sha AS "commitSha", created_at AS "createdAt", started_at AS "startedAt", finished_at AS "finishedAt", error, log_truncated AS "logTruncated", CASE WHEN started_at IS NULL THEN NULL ELSE (extract(epoch FROM (started_at - created_at)) * 1000)::float8 END AS "queueWaitMs", CASE WHEN finished_at IS NULL OR started_at IS NULL THEN NULL ELSE (extract(epoch FROM (finished_at - started_at)) * 1000)::float8 END AS "buildDurationMs"`;

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

export async function activateDeployment(id: string, commitSha: string, manifest: ArtifactManifest): Promise<'active' | 'superseded' | null> {
  if (manifest.deploymentId !== id) throw new Error('Artifact manifest belongs to a different deployment');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const project = await client.query<{ id: string }>('SELECT p.id FROM projects p JOIN deployments d ON d.project_id = p.id WHERE d.id = $1 FOR UPDATE OF p', [id]);
    if (!project.rowCount) { await client.query('COMMIT'); return null; }
    const result = await client.query<{ publish_generation: string }>("UPDATE deployments SET status = 'deployed', commit_sha = $2, artifact_manifest = $3::jsonb, finished_at = now() WHERE id = $1 AND status = 'building' RETURNING publish_generation", [id, commitSha, JSON.stringify(manifest)]);
    if (!result.rowCount) { await client.query('COMMIT'); return null; }
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
