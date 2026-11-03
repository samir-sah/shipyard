import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pool, migrate, createDeployment, claimDeployment, recordDeploymentCommit, activateDeployment, rollbackDeployment, failDeployment, appendLog } from '../../src/db.js';
import { config } from '../../src/config.js';
import type { ArtifactManifest, Deployment, DeploymentClaim } from '../../src/contracts.js';

const claimsById = new Map<string, DeploymentClaim>();

function manifest(id: string): ArtifactManifest {
  const claim = claimsById.get(id);
  return { version: 1, deploymentId: id, attemptId: claim?.token ?? '00000000-0000-0000-0000-000000000000', commitSha: claim?.commitSha ?? 'a'.repeat(40), files: [{ key: 'index.html', size: 2, sha256: 'f'.repeat(64) }], totalBytes: 2 };
}

test('version selection, rollback and persistence use real PostgreSQL transactions', { skip: process.env.RUN_INTEGRATION !== '1' }, async t => {
  const projects: string[] = [];
  async function project(): Promise<string> {
    const id = randomUUID();
    projects.push(id);
    await pool.query('INSERT INTO projects(id, name, slug, repo_url) VALUES ($1, $2, $3, $4)', [id, 'Integration test', `integration-${id}`, 'https://github.com/example/site.git']);
    return id;
  }
  async function queued(projectId: string): Promise<Deployment> {
    const deployment = await createDeployment(projectId);
    assert.ok(deployment);
    return deployment;
  }
  async function complete(deployment: Deployment) {
    assert.equal((await claim(deployment.id))?.repoUrl, 'https://github.com/example/site.git');
    return publish(deployment.id, 'a'.repeat(40));
  }
  async function claim(id: string) {
    const result = await claimDeployment(id, 1);
    if (result) claimsById.set(id, result);
    return result;
  }
  async function publish(id: string, sha: string) {
    const claim = claimsById.get(id);
    const token = claim?.token ?? '00000000-0000-0000-0000-000000000000';
    if (claim && await recordDeploymentCommit(id, token, sha)) claim.commitSha = sha;
    return activateDeployment(id, token, sha, { ...manifest(id), commitSha: sha });
  }
  async function state(projectId: string) {
    const result = await pool.query<{ active_deployment_id: string | null; publish_generation: string }>('SELECT active_deployment_id, publish_generation FROM projects WHERE id = $1', [projectId]);
    return result.rows[0];
  }
  try {
    await migrate();
    await migrate();

    await t.test('duplicate claims and completion are guarded; failure preserves the active version; logs remain bounded', async () => {
      const projectId = await project();
      const first = await queued(projectId);
      assert.equal(await publish(first.id, 'a'.repeat(40)), null);
      const claims = await Promise.all([claim(first.id), claim(first.id)]);
      assert.equal(claims.filter(Boolean).length, 1);
      assert.equal(await publish(first.id, 'a'.repeat(40)), 'active');
      assert.equal(await publish(first.id, 'b'.repeat(40)), null);
      assert.equal(await failDeployment(first.id, claimsById.get(first.id)!.token, 'late failure'), null);
      const failed = await queued(projectId);
      const failedClaim = await claim(failed.id);
      assert.ok(failedClaim);
      assert.equal(await failDeployment(failed.id, failedClaim.token, 'npm build failed'), config.maxBuildAttempts > 1 ? 'retry' : 'failed');
      assert.equal((await state(projectId)).active_deployment_id, first.id);
      await appendLog(failed.id, 'stdout', 'binary\0output');
      const sanitized = await pool.query('SELECT message FROM deployment_logs WHERE deployment_id = $1', [failed.id]);
      assert.equal(sanitized.rows[0].message, 'binary\uFFFDoutput');
      await Promise.all([appendLog(failed.id, 'stdout', 'x'.repeat(config.maxLogBytes)), appendLog(failed.id, 'stderr', 'overflow')]);
      const logs = await pool.query('SELECT log_bytes, log_truncated FROM deployments WHERE id = $1', [failed.id]);
      assert.equal(logs.rows[0].log_bytes, config.maxLogBytes);
      assert.equal(logs.rows[0].log_truncated, true);
      const actual = await pool.query('SELECT coalesce(sum(octet_length(message)), 0)::integer AS bytes FROM deployment_logs WHERE deployment_id = $1', [failed.id]);
      assert.equal(actual.rows[0].bytes, config.maxLogBytes);
    });

    await t.test('B finishing before A leaves B active and retains A as a completed version', async () => {
      const projectId = await project();
      const a = await queued(projectId);
      const b = await queued(projectId);
      await Promise.all([claim(a.id), claim(b.id)]);
      assert.equal(await publish(b.id, 'b'.repeat(40)), 'active');
      assert.equal(await publish(a.id, 'a'.repeat(40)), 'superseded');
      assert.equal((await state(projectId)).active_deployment_id, b.id);
      const retained = await pool.query('SELECT status, artifact_manifest FROM deployments WHERE id = $1', [a.id]);
      assert.equal(retained.rows[0].status, 'deployed');
      assert.deepEqual(retained.rows[0].artifact_manifest, manifest(a.id));
    });

    await t.test('a failed latest request does not permit an older build to replace the active site', async () => {
      const projectId = await project();
      const initial = await queued(projectId);
      assert.equal(await complete(initial), 'active');
      const a = await queued(projectId);
      const b = await queued(projectId);
      await Promise.all([claim(a.id), claim(b.id)]);
      await failDeployment(b.id, claimsById.get(b.id)!.token, 'Latest build failed');
      assert.equal(await publish(a.id, 'a'.repeat(40)), 'superseded');
      assert.equal((await state(projectId)).active_deployment_id, initial.id);
    });

    await t.test('rollback blocks an overlapping build while a request after rollback may become active', async () => {
      const projectId = await project();
      const initial = await queued(projectId);
      await complete(initial);
      const current = await queued(projectId);
      await complete(current);
      const overlapping = await queued(projectId);
      await claim(overlapping.id);
      const rolledBack = await rollbackDeployment(projectId, initial.id, manifest(initial.id));
      assert.equal(rolledBack?.activeDeploymentId, initial.id);
      assert.equal(await publish(overlapping.id, 'c'.repeat(40)), 'superseded');
      assert.equal((await state(projectId)).active_deployment_id, initial.id);
      const next = await queued(projectId);
      assert.equal(await complete(next), 'active');
      assert.equal((await state(projectId)).active_deployment_id, next.id);
    });

    await t.test('cross-project, incomplete, missing and mismatched rollback targets leave generation and active selection unchanged', async () => {
      const projectId = await project();
      const otherProject = await project();
      const other = await queued(otherProject);
      await complete(other);
      const completed = await queued(projectId);
      await complete(completed);
      const incomplete = await queued(projectId);
      const before = await state(projectId);
      assert.equal(await rollbackDeployment(projectId, other.id, manifest(other.id)), null);
      assert.equal(await rollbackDeployment(projectId, incomplete.id, manifest(incomplete.id)), null);
      const missing = randomUUID();
      assert.equal(await rollbackDeployment(projectId, missing, manifest(missing)), null);
      const changedManifest = manifest(completed.id);
      changedManifest.files[0].sha256 = 'e'.repeat(64);
      assert.equal(await rollbackDeployment(projectId, completed.id, changedManifest), null);
      assert.deepEqual(await state(projectId), before);
    });

    await t.test('rollback racing with completion serializes without losing the requested rollback', async () => {
      const projectId = await project();
      const initial = await queued(projectId);
      await complete(initial);
      const current = await queued(projectId);
      await complete(current);
      const overlapping = await queued(projectId);
      await claim(overlapping.id);
      const [completed, rolledBack] = await Promise.all([
        publish(overlapping.id, 'c'.repeat(40)),
        rollbackDeployment(projectId, initial.id, manifest(initial.id)),
      ]);
      assert.ok(completed === 'active' || completed === 'superseded');
      assert.equal(rolledBack?.activeDeploymentId, initial.id);
      assert.equal((await state(projectId)).active_deployment_id, initial.id);
    });

    await t.test('legacy completed versions receive their validated manifest during rollback', async () => {
      const projectId = await project();
      const legacy = await queued(projectId);
      await complete(legacy);
      await pool.query('UPDATE deployments SET artifact_manifest = NULL WHERE id = $1', [legacy.id]);
      assert.equal((await rollbackDeployment(projectId, legacy.id, manifest(legacy.id)))?.activeDeploymentId, legacy.id);
      const stored = await pool.query('SELECT artifact_manifest FROM deployments WHERE id = $1', [legacy.id]);
      assert.deepEqual(stored.rows[0].artifact_manifest, manifest(legacy.id));
    });

    await t.test('migration backfills request order while preserving legacy active pointers and records', async () => {
      const client = await pool.connect();
      const schema = `shipyard_migration_${randomUUID().replaceAll('-', '')}`;
      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await client.query(await readFile('migrations/001_initial.sql', 'utf8'));
        const projectId = randomUUID();
        const first = randomUUID();
        const second = randomUUID();
        await client.query('INSERT INTO projects(id, name, slug, repo_url) VALUES ($1, $2, $3, $4)', [projectId, 'Legacy', 'legacy', 'https://github.com/example/site.git']);
        await client.query("INSERT INTO deployments(id, project_id, status, created_at) VALUES ($1, $3, 'deployed', '2026-01-01'), ($2, $3, 'building', '2026-01-02')", [first, second, projectId]);
        await client.query('UPDATE projects SET active_deployment_id = $2 WHERE id = $1', [projectId, first]);
        await client.query(await readFile('migrations/002_version_selection.sql', 'utf8'));
        const project = await client.query('SELECT active_deployment_id, publish_generation FROM projects WHERE id = $1', [projectId]);
        assert.deepEqual(project.rows[0], { active_deployment_id: first, publish_generation: '2' });
        const versions = await client.query('SELECT id, publish_generation, artifact_manifest FROM deployments ORDER BY publish_generation');
        assert.deepEqual(versions.rows, [{ id: first, publish_generation: '1', artifact_manifest: null }, { id: second, publish_generation: '2', artifact_manifest: null }]);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
  } finally {
    if (projects.length) {
      await pool.query('UPDATE projects SET active_deployment_id = NULL WHERE id = ANY($1::uuid[])', [projects]);
      await pool.query('DELETE FROM deployment_logs WHERE deployment_id IN (SELECT id FROM deployments WHERE project_id = ANY($1::uuid[]))', [projects]);
      await pool.query('DELETE FROM deployments WHERE project_id = ANY($1::uuid[])', [projects]);
      await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projects]);
    }
    await pool.end();
  }
});
