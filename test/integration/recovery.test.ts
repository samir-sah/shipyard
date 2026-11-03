import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pool, migrate, createDeployment, claimDeployment, renewClaim, recordDeploymentCommit, activateDeployment, failDeployment, recoverExpiredClaims, appendLog, isClaimActive, listAbandonedAttempts, markAttemptCleaned } from '../../src/db.js';
import { config } from '../../src/config.js';
import type { ArtifactManifest, DeploymentClaim } from '../../src/contracts.js';

const commitSha = 'a'.repeat(40);
function manifest(claim: DeploymentClaim): ArtifactManifest {
  return { version: 1, deploymentId: claim.deploymentId, attemptId: claim.token, commitSha, files: [{ key: 'index.html', size: 2, sha256: 'f'.repeat(64) }], totalBytes: 2 };
}

test('worker leases, retries and cleanup are fenced by persisted attempt tokens', { skip: process.env.RUN_INTEGRATION !== '1' }, async t => {
  const projects: string[] = [];
  async function project(): Promise<string> {
    const id = randomUUID();
    projects.push(id);
    await pool.query('INSERT INTO projects(id, name, slug, repo_url) VALUES ($1, $2, $3, $4)', [id, 'Recovery test', `recovery-${id}`, 'https://github.com/example/site.git']);
    return id;
  }
  async function deployment(projectId: string): Promise<string> {
    const result = await createDeployment(projectId);
    assert.ok(result);
    return result.id;
  }
  async function claim(id: string, attempt = 1): Promise<DeploymentClaim> {
    const result = await claimDeployment(id, attempt);
    assert.ok(result);
    return result;
  }
  async function expire(id: string) {
    await pool.query("UPDATE deployments SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
  }
  async function due(id: string) {
    await pool.query("UPDATE deployments SET retry_at = clock_timestamp() - interval '1 second' WHERE id = $1", [id]);
  }
  try {
    await migrate();
    await migrate();
    await t.test('duplicate expected-attempt deliveries create exactly one persisted claim', async () => {
      const id = await deployment(await project());
      const results = await Promise.all([claimDeployment(id, 1), claimDeployment(id, 1), claimDeployment(id, 1)]);
      const claims = results.filter((result): result is DeploymentClaim => result !== null);
      assert.equal(claims.length, 1);
      const winner = claims[0];
      assert.equal(winner.attempt, 1);
      assert.equal(winner.commitSha, null);
      assert.equal(await isClaimActive(winner.token), true);
      assert.equal(await renewClaim(id, winner.token), true);
      assert.equal(await claimDeployment(id, 2), null);
      assert.equal(await claimDeployment(id, 0), null);
      const attempts = await pool.query('SELECT token, attempt_number, status FROM build_attempts WHERE deployment_id = $1', [id]);
      assert.deepEqual(attempts.rows, [{ token: winner.token, attempt_number: 1, status: 'building' }]);
    });

    await t.test('expired workers cannot renew, log, pin commits, fail or publish after recovery', { skip: config.maxBuildAttempts < 2 }, async () => {
      const projectId = await project();
      const id = await deployment(projectId);
      const first = await claim(id);
      assert.equal(await recordDeploymentCommit(id, first.token, commitSha), true);
      await appendLog(id, 'stdout', 'valid log', first.token);
      const before = await pool.query('SELECT started_at FROM deployments WHERE id = $1', [id]);
      await expire(id);
      assert.equal(await isClaimActive(first.token), false);
      assert.equal(await renewClaim(id, first.token), false);
      assert.equal(await recordDeploymentCommit(id, first.token, commitSha), false);
      assert.equal(await activateDeployment(id, first.token, commitSha, manifest(first)), null);
      assert.equal(await failDeployment(id, first.token, 'stale failure'), null);
      await appendLog(id, 'stdout', 'stale log', first.token);
      assert.ok(await recoverExpiredClaims() >= 1);
      const expired = await pool.query('SELECT status FROM build_attempts WHERE token = $1', [first.token]);
      assert.equal(expired.rows[0].status, 'expired');
      await due(id);
      assert.equal(await claimDeployment(id, 1), null);
      const second = await claim(id, 2);
      assert.notEqual(second.token, first.token);
      assert.equal(second.commitSha, commitSha);
      assert.equal(second.attempt, 2);
      const after = await pool.query('SELECT started_at FROM deployments WHERE id = $1', [id]);
      assert.equal(after.rows[0].started_at.toISOString(), before.rows[0].started_at.toISOString());
      assert.equal(await renewClaim(id, first.token), false);
      assert.equal(await failDeployment(id, first.token, 'late failure'), null);
      assert.equal(await activateDeployment(id, first.token, commitSha, manifest(first)), null);
      assert.equal(await recordDeploymentCommit(id, second.token, 'b'.repeat(40)), false);
      assert.equal(await recordDeploymentCommit(id, second.token, commitSha), true);
      assert.equal(await activateDeployment(id, second.token, commitSha, manifest(first)), null);
      assert.equal(await activateDeployment(id, second.token, commitSha, { ...manifest(second), commitSha: 'b'.repeat(40) }), null);
      assert.equal(await activateDeployment(id, second.token, commitSha, manifest(second)), 'active');
      assert.equal(await isClaimActive(second.token), false);
      const logs = await pool.query('SELECT message FROM deployment_logs WHERE deployment_id = $1 ORDER BY id', [id]);
      assert.deepEqual(logs.rows.map(row => row.message), ['valid log']);
      const attempts = await pool.query('SELECT status FROM build_attempts WHERE deployment_id = $1 ORDER BY attempt_number', [id]);
      assert.deepEqual(attempts.rows.map(row => row.status), ['expired', 'completed']);
    });

    await t.test('bounded failures retain the previous active deployment and enforce retry timing', async () => {
      const projectId = await project();
      const activeId = await deployment(projectId);
      const active = await claim(activeId);
      await recordDeploymentCommit(activeId, active.token, commitSha);
      assert.equal(await activateDeployment(activeId, active.token, commitSha, manifest(active)), 'active');
      const id = await deployment(projectId);
      for (let attempt = 1; attempt <= config.maxBuildAttempts; attempt++) {
        const current = await claim(id, attempt);
        assert.equal(await recordDeploymentCommit(id, current.token, commitSha), true);
        assert.equal(await failDeployment(id, current.token, `failure ${attempt}`), attempt < config.maxBuildAttempts ? 'retry' : 'failed');
        assert.equal(await failDeployment(id, current.token, 'duplicate failure'), null);
        assert.equal(await claimDeployment(id, attempt), null);
        if (attempt < config.maxBuildAttempts) {
          const delay = await pool.query("SELECT d.retry_at >= a.finished_at + interval '1 second' AND d.retry_at <= a.finished_at + interval '61 seconds' AS bounded FROM deployments d JOIN build_attempts a ON a.deployment_id = d.id WHERE a.token = $1", [current.token]);
          assert.equal(delay.rows[0].bounded, true);
          await pool.query("UPDATE deployments SET retry_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [id]);
          assert.equal(await claimDeployment(id, attempt + 1), null);
          await due(id);
        }
      }
      const result = await pool.query('SELECT status, attempt_count, claim_token, lease_expires_at, finished_at FROM deployments WHERE id = $1', [id]);
      assert.equal(result.rows[0].status, 'failed');
      assert.equal(result.rows[0].attempt_count, config.maxBuildAttempts);
      assert.equal(result.rows[0].claim_token, null);
      assert.equal(result.rows[0].lease_expires_at, null);
      assert.ok(result.rows[0].finished_at);
      assert.equal(await claimDeployment(id, config.maxBuildAttempts + 1), null);
      const selected = await pool.query('SELECT active_deployment_id FROM projects WHERE id = $1', [projectId]);
      assert.equal(selected.rows[0].active_deployment_id, activeId);
    });

    await t.test('a lowered attempt limit closes already queued retries without changing the active site', async () => {
      const projectId = await project();
      const activeId = await deployment(projectId);
      const active = await claim(activeId);
      await recordDeploymentCommit(activeId, active.token, commitSha);
      assert.equal(await activateDeployment(activeId, active.token, commitSha, manifest(active)), 'active');
      const id = await deployment(projectId);
      await pool.query("UPDATE deployments SET attempt_count = $2, error = 'Previous attempt failed', retry_at = clock_timestamp() + interval '1 hour' WHERE id = $1", [id, config.maxBuildAttempts]);
      await recoverExpiredClaims();
      assert.equal((await pool.query('SELECT status FROM deployments WHERE id = $1', [id])).rows[0].status, 'queued');
      await due(id);
      assert.ok(await recoverExpiredClaims() >= 1);
      const exhausted = await pool.query('SELECT status, finished_at, claim_token, lease_expires_at, error FROM deployments WHERE id = $1', [id]);
      assert.equal(exhausted.rows[0].status, 'failed');
      assert.ok(exhausted.rows[0].finished_at);
      assert.equal(exhausted.rows[0].claim_token, null);
      assert.equal(exhausted.rows[0].lease_expires_at, null);
      assert.match(exhausted.rows[0].error, /Previous attempt failed[\s\S]*attempt limit reached/);
      assert.equal((await pool.query('SELECT active_deployment_id FROM projects WHERE id = $1', [projectId])).rows[0].active_deployment_id, activeId);
    });

    await t.test('publication rechecks expiry after waiting for the project lock', async () => {
      const projectId = await project();
      const id = await deployment(projectId);
      const current = await claim(id);
      await recordDeploymentCommit(id, current.token, commitSha);
      const blocker = await pool.connect();
      let publication: Promise<'active' | 'superseded' | null> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
        publication = activateDeployment(id, current.token, commitSha, manifest(current));
        await expire(id);
        await blocker.query('COMMIT');
        assert.equal(await publication, null);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await publication;
      }
    });

    await t.test('recovery skips locked deployments and another pass recovers them', async () => {
      const projectId = await project();
      const lockedId = await deployment(projectId);
      const otherId = await deployment(projectId);
      await claim(lockedId);
      await claim(otherId);
      await expire(lockedId);
      await expire(otherId);
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM deployments WHERE id = $1 FOR UPDATE', [lockedId]);
        assert.ok(await recoverExpiredClaims() >= 1);
        const states = await pool.query('SELECT id, status FROM deployments WHERE id = ANY($1::uuid[])', [[lockedId, otherId]]);
        assert.equal(states.rows.find(row => row.id === lockedId)?.status, 'building');
        assert.notEqual(states.rows.find(row => row.id === otherId)?.status, 'building');
      } finally { await blocker.query('ROLLBACK'); blocker.release(); }
      assert.ok(await recoverExpiredClaims() >= 1);
    });

    await t.test('cleanup rotates abandoned attempts and excludes retained or current attempts', async () => {
      const id = await deployment(await project());
      const current = await claim(id);
      assert.ok(!(await listAbandonedAttempts()).some(row => row.token === current.token));
      await failDeployment(id, current.token, 'cleanup fixture');
      assert.ok((await listAbandonedAttempts()).some(row => row.deploymentId === id && row.token === current.token));
      await markAttemptCleaned(current.token);
      assert.ok(!(await listAbandonedAttempts()).some(row => row.token === current.token));
      await pool.query("UPDATE build_attempts SET last_cleanup_at = clock_timestamp() - interval '61 seconds' WHERE token = $1", [current.token]);
      assert.ok((await listAbandonedAttempts()).some(row => row.token === current.token));
      await pool.query('UPDATE deployments SET artifact_manifest = $2::jsonb WHERE id = $1', [id, JSON.stringify(manifest(current))]);
      assert.ok(!(await listAbandonedAttempts()).some(row => row.token === current.token));
    });

    await t.test('migration requeues unclaimed M2 work without changing deployed history or the active pointer', async () => {
      const client = await pool.connect();
      const schema = `shipyard_recovery_${randomUUID().replaceAll('-', '')}`;
      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        await client.query(await readFile('migrations/001_initial.sql', 'utf8'));
        await client.query(await readFile('migrations/002_version_selection.sql', 'utf8'));
        const projectId = randomUUID();
        const activeId = randomUUID();
        const buildingId = randomUUID();
        await client.query('INSERT INTO projects(id, name, slug, repo_url) VALUES ($1, $2, $3, $4)', [projectId, 'M2 history', 'm2-history', 'https://github.com/example/site.git']);
        const legacyManifest = { version: 1, deploymentId: activeId, files: [{ key: 'index.html', size: 2, sha256: 'f'.repeat(64) }], totalBytes: 2 };
        await client.query("INSERT INTO deployments(id, project_id, status, commit_sha, artifact_manifest, started_at, finished_at) VALUES ($1, $3, 'deployed', $4, $5::jsonb, '2026-01-01', '2026-01-02'), ($2, $3, 'building', NULL, NULL, '2026-01-03', NULL)", [activeId, buildingId, projectId, commitSha, JSON.stringify(legacyManifest)]);
        await client.query('UPDATE projects SET active_deployment_id = $2 WHERE id = $1', [projectId, activeId]);
        await client.query(await readFile('migrations/003_worker_claims.sql', 'utf8'));
        const project = await client.query('SELECT active_deployment_id FROM projects WHERE id = $1', [projectId]);
        assert.equal(project.rows[0].active_deployment_id, activeId);
        const versions = await client.query('SELECT id, status, artifact_manifest, attempt_count, claim_token, started_at, finished_at, error FROM deployments ORDER BY started_at');
        assert.equal(versions.rows.length, 2);
        assert.equal(versions.rows[0].id, activeId);
        assert.equal(versions.rows[0].status, 'deployed');
        assert.deepEqual(versions.rows[0].artifact_manifest, legacyManifest);
        assert.ok(versions.rows[0].finished_at);
        assert.equal(versions.rows[1].id, buildingId);
        assert.equal(versions.rows[1].status, 'queued');
        assert.equal(versions.rows[1].attempt_count, 0);
        assert.equal(versions.rows[1].claim_token, null);
        assert.ok(versions.rows[1].started_at);
        assert.equal(versions.rows[1].finished_at, null);
        assert.match(versions.rows[1].error, /worker-claim upgrade/);
        assert.equal((await client.query('SELECT count(*)::integer AS count FROM build_attempts')).rows[0].count, 0);
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
