import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { config } from '../../src/config.js';
import { pool, migrate, legacyOwnerId, createDeployment, claimDeployment, recordDeploymentCommit, activateDeployment, rollbackDeployment, configureWebhook, acceptWebhook, setDeploymentRetained, claimArtifactDeletions, finishArtifactDeletion } from '../../src/db.js';
import type { ArtifactManifest } from '../../src/contracts.js';
import { isolateDatabase } from '../isolated-db.js';

const commitSha = 'a'.repeat(40);

test('ownership migration, webhook deliveries and retention preserve deployment history', { skip: process.env.RUN_INTEGRATION !== '1' }, async t => {
  const restoreDb = await isolateDatabase();
  const projects: string[] = [];
  const manifests = new Map<string, ArtifactManifest>();
  const originalRetention = { days: config.retentionDays, keep: config.retentionKeep };
  async function project(ownerId = legacyOwnerId): Promise<string> {
    const id = randomUUID();
    projects.push(id);
    await pool.query('INSERT INTO projects(id, name, slug, repo_url, owner_id) VALUES ($1, $2, $3, $4, $5)', [id, 'Operations test', `operations-${id}`, 'https://github.com/example/site.git', ownerId]);
    return id;
  }
  async function complete(projectId: string, daysOld = 0): Promise<string> {
    const deployment = await createDeployment(projectId);
    assert.ok(deployment);
    const claim = await claimDeployment(deployment.id, 1);
    assert.ok(claim);
    assert.equal(await recordDeploymentCommit(deployment.id, claim.token, commitSha), true);
    const manifest: ArtifactManifest = { version: 1, deploymentId: deployment.id, attemptId: claim.token, commitSha, files: [{ key: 'index.html', size: 2, sha256: 'f'.repeat(64) }], totalBytes: 2 };
    assert.equal(await activateDeployment(deployment.id, claim.token, commitSha, manifest), 'active');
    manifests.set(deployment.id, manifest);
    if (daysOld) await pool.query("UPDATE deployments SET finished_at = clock_timestamp() - $2 * interval '1 day' WHERE id = $1", [deployment.id, daysOld]);
    return deployment.id;
  }
  async function state(id: string) {
    return (await pool.query('SELECT artifact_state, retained, artifact_manifest FROM deployments WHERE id = $1', [id])).rows[0];
  }
  try {
    await migrate();
    await migrate();
    config.retentionDays = 0;
    config.retentionKeep = 1;

    await t.test('concurrent webhook redelivery creates one pinned deployment and one generation', async () => {
      const projectId = await project();
      assert.equal(await configureWebhook(projectId, randomUUID(), true), null);
      const enabled = await configureWebhook(projectId, legacyOwnerId, true);
      assert.ok(enabled);
      assert.equal(enabled.project.ownerId, legacyOwnerId);
      assert.equal(enabled.project.webhookEnabled, true);
      assert.equal(enabled.keyVersion, 1);
      const deliveryId = randomUUID();
      const results = await Promise.all(Array.from({ length: 4 }, () => acceptWebhook(projectId, enabled.keyVersion, deliveryId, 'f'.repeat(64), 'push', commitSha)));
      const accepted = results.filter((result): result is { duplicate: boolean; deploymentId: string | null } => result !== null && typeof result === 'object');
      assert.equal(accepted.length, 4);
      assert.equal(accepted.filter(result => !result.duplicate).length, 1);
      const deploymentId = accepted[0].deploymentId;
      assert.ok(deploymentId);
      assert.ok(accepted.every(result => result.deploymentId === deploymentId));
      const deployments = await pool.query('SELECT id, commit_sha FROM deployments WHERE project_id = $1', [projectId]);
      assert.deepEqual(deployments.rows, [{ id: deploymentId, commit_sha: commitSha }]);
      assert.equal((await pool.query('SELECT publish_generation FROM projects WHERE id = $1', [projectId])).rows[0].publish_generation, '1');
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM webhook_deliveries WHERE project_id = $1', [projectId])).rows[0].count, 1);
      assert.equal(await acceptWebhook(projectId, enabled.keyVersion, deliveryId, 'e'.repeat(64), 'push', commitSha), 'conflict');
      assert.equal(await acceptWebhook(projectId, enabled.keyVersion, deliveryId, 'f'.repeat(64), 'ping', null), 'conflict');
      const ping = randomUUID();
      assert.deepEqual(await acceptWebhook(projectId, enabled.keyVersion, ping, 'd'.repeat(64), 'ping', null), { duplicate: false, deploymentId: null });
      assert.deepEqual(await acceptWebhook(projectId, enabled.keyVersion, ping, 'd'.repeat(64), 'ping', null), { duplicate: true, deploymentId: null });
      assert.equal((await pool.query('SELECT publish_generation FROM projects WHERE id = $1', [projectId])).rows[0].publish_generation, '1');
      const rotated = await configureWebhook(projectId, legacyOwnerId, true);
      assert.ok(rotated);
      assert.equal(rotated.keyVersion, 2);
      assert.equal(await acceptWebhook(projectId, enabled.keyVersion, randomUUID(), 'c'.repeat(64), 'push', commitSha), 'disabled');
      assert.deepEqual(await acceptWebhook(projectId, rotated.keyVersion, deliveryId, 'f'.repeat(64), 'push', commitSha), { duplicate: true, deploymentId });
      const disabled = await configureWebhook(projectId, legacyOwnerId, false);
      assert.ok(disabled);
      assert.equal(disabled.keyVersion, 3);
      assert.equal(disabled.project.webhookEnabled, false);
      assert.equal(await acceptWebhook(projectId, disabled.keyVersion, randomUUID(), 'c'.repeat(64), 'push', commitSha), 'disabled');
      assert.equal(await acceptWebhook(randomUUID(), 1, randomUUID(), 'c'.repeat(64), 'push', commitSha), null);
      await assert.rejects(createDeployment(projectId, 'invalid-commit'));
      const manual = await createDeployment(projectId, 'b'.repeat(40));
      assert.equal(manual?.commitSha, 'b'.repeat(40));
    });

    await t.test('retention disabled claims no new versions, and retaining a version checks its project and status', async () => {
      const projectId = await project();
      const old = await complete(projectId, 30);
      await complete(projectId, 20);
      config.retentionDays = 0;
      assert.ok(!(await claimArtifactDeletions()).some(row => row.deploymentId === old));
      assert.equal((await state(old)).artifact_state, 'available');
      assert.equal((await setDeploymentRetained(projectId, old, true))?.retained, true);
      assert.equal(await setDeploymentRetained(await project(), old, false), null);
      assert.equal((await state(old)).retained, true);
      assert.equal((await setDeploymentRetained(projectId, old, false))?.retained, false);
      const queued = await createDeployment(projectId);
      assert.ok(queued);
      assert.equal(await setDeploymentRetained(projectId, queued.id, true), null);
    });

    await t.test('retention protects active, retained and newest versions and resumes irreversible deletion after disabling new claims', async () => {
      const projectId = await project();
      const versions: string[] = [];
      for (let index = 0; index < 6; index++) versions.push(await complete(projectId, 50 - index));
      assert.ok(await rollbackDeployment(projectId, versions[0], manifests.get(versions[0])!));
      assert.ok(await setDeploymentRetained(projectId, versions[1], true));
      config.retentionDays = 1;
      config.retentionKeep = 2;
      const claimed = await claimArtifactDeletions(100);
      const own = claimed.filter(row => versions.includes(row.deploymentId));
      assert.deepEqual(own.map(row => row.deploymentId).sort(), [versions[2], versions[3]].sort());
      for (const index of [0, 1, 4, 5]) assert.equal((await state(versions[index])).artifact_state, 'available');
      for (const index of [2, 3]) {
        assert.equal((await state(versions[index])).artifact_state, 'deleting');
        assert.equal(await rollbackDeployment(projectId, versions[index], manifests.get(versions[index])!), null);
        assert.equal(await setDeploymentRetained(projectId, versions[index], true), null);
      }
      config.retentionDays = 0;
      const resumed = await claimArtifactDeletions(100);
      assert.ok(own.every(row => resumed.some(retry => retry.deploymentId === row.deploymentId)));
      for (const row of claimed) await finishArtifactDeletion(row.deploymentId);
      for (const index of [2, 3]) {
        assert.equal((await state(versions[index])).artifact_state, 'deleted');
        assert.deepEqual((await state(versions[index])).artifact_manifest, manifests.get(versions[index]));
        await finishArtifactDeletion(versions[index]);
      }
      assert.equal((await pool.query('SELECT count(*)::integer AS count FROM deployments WHERE project_id = $1', [projectId])).rows[0].count, 6);
      assert.equal((await pool.query('SELECT active_deployment_id FROM projects WHERE id = $1', [projectId])).rows[0].active_deployment_id, versions[0]);
    });

    await t.test('retention serializes with retain and rollback so an unavailable version never becomes protected or active', async () => {
      config.retentionDays = 1;
      config.retentionKeep = 1;
      const projectId = await project();
      const old = await complete(projectId, 40);
      const latest = await complete(projectId, 30);
      const [retained, claimed] = await Promise.all([setDeploymentRetained(projectId, old, true), claimArtifactDeletions(100)]);
      const deletionWon = claimed.some(row => row.deploymentId === old);
      assert.equal(Boolean(retained), !deletionWon);
      assert.equal((await state(old)).artifact_state, deletionWon ? 'deleting' : 'available');
      assert.equal((await pool.query('SELECT active_deployment_id FROM projects WHERE id = $1', [projectId])).rows[0].active_deployment_id, latest);
      for (const row of claimed) await finishArtifactDeletion(row.deploymentId);
      const otherProject = await project();
      const target = await complete(otherProject, 40);
      const current = await complete(otherProject, 30);
      const [rolledBack, nextClaims] = await Promise.all([rollbackDeployment(otherProject, target, manifests.get(target)!), claimArtifactDeletions(100)]);
      const deletionClaim = nextClaims.some(row => row.deploymentId === target);
      assert.equal(Boolean(rolledBack), !deletionClaim);
      assert.equal((await pool.query('SELECT active_deployment_id FROM projects WHERE id = $1', [otherProject])).rows[0].active_deployment_id, deletionClaim ? current : target);
      for (const row of nextClaims) await finishArtifactDeletion(row.deploymentId);
    });

    await t.test('migration assigns the fixed legacy owner and preserves artifacts, metadata and active selection', async () => {
      const client = await pool.connect();
      const schema = `shipyard_operations_${randomUUID().replaceAll('-', '')}`;
      try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA "${schema}"`);
        await client.query(`SET LOCAL search_path TO "${schema}"`);
        for (const file of ['001_initial.sql', '002_version_selection.sql', '003_worker_claims.sql']) await client.query(await readFile(`migrations/${file}`, 'utf8'));
        const projectId = randomUUID();
        const deploymentId = randomUUID();
        const legacyManifest: ArtifactManifest = { version: 1, deploymentId, files: [{ key: 'index.html', size: 2, sha256: 'f'.repeat(64) }], totalBytes: 2 };
        await client.query('INSERT INTO projects(id, name, slug, repo_url) VALUES ($1, $2, $3, $4)', [projectId, 'Legacy project', 'legacy-project', 'https://github.com/example/site.git']);
        await client.query("INSERT INTO deployments(id, project_id, status, artifact_manifest, commit_sha, finished_at) VALUES ($1, $2, 'deployed', $3::jsonb, $4, clock_timestamp())", [deploymentId, projectId, JSON.stringify(legacyManifest), commitSha]);
        await client.query('UPDATE projects SET active_deployment_id = $2 WHERE id = $1', [projectId, deploymentId]);
        await client.query(await readFile('migrations/004_ownership_webhooks_retention.sql', 'utf8'));
        const migrated = (await client.query('SELECT owner_id, webhook_enabled, webhook_key_version, active_deployment_id FROM projects WHERE id = $1', [projectId])).rows[0];
        assert.deepEqual(migrated, { owner_id: legacyOwnerId, webhook_enabled: false, webhook_key_version: 0, active_deployment_id: deploymentId });
        const artifact = (await client.query('SELECT status, artifact_state, retained, artifact_manifest, commit_sha FROM deployments WHERE id = $1', [deploymentId])).rows[0];
        assert.deepEqual(artifact, { status: 'deployed', artifact_state: 'available', retained: false, artifact_manifest: legacyManifest, commit_sha: commitSha });
        assert.equal((await client.query('SELECT count(*)::integer AS count FROM webhook_deliveries')).rows[0].count, 0);
      } finally { await client.query('ROLLBACK'); client.release(); }
    });
  } finally {
    config.retentionDays = originalRetention.days;
    config.retentionKeep = originalRetention.keep;
    try {
      if (projects.length) {
        await pool.query('UPDATE projects SET active_deployment_id = NULL WHERE id = ANY($1::uuid[])', [projects]);
        await pool.query('DELETE FROM deployment_logs WHERE deployment_id IN (SELECT id FROM deployments WHERE project_id = ANY($1::uuid[]))', [projects]);
        await pool.query('DELETE FROM deployments WHERE project_id = ANY($1::uuid[])', [projects]);
        await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projects]);
      }
    } finally { await restoreDb(); }
  }
});
