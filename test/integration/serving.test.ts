import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeleteObjectsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createApp } from '../../src/api.js';
import { pool, migrate, claimDeployment, activateDeployment, recordDeploymentCommit } from '../../src/db.js';
import { deleteAttemptArtifacts, ensureBucket, s3, uploadArtifacts } from '../../src/storage.js';
import { config } from '../../src/config.js';
import type { ArtifactManifest, Deployment, Project } from '../../src/contracts.js';

test('API restores validated versions and keeps previously opened asset URLs pinned', { skip: process.env.RUN_INTEGRATION !== '1' }, async () => {
  const { queue } = await import('../../src/queue.js');
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-serving-'));
  const deployments: Deployment[] = [];
  const manifests: ArtifactManifest[] = [];
  let project: Project | undefined;
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  async function post(path: string, body: unknown) {
    return fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  }
  async function writeOutput(label: string) {
    await writeFile(join(directory, 'index.html'), `<script type="module" src="./assets/app.js"></script><h1>${label}</h1>`);
    await writeFile(join(directory, 'assets', 'app.js'), `console.log(${JSON.stringify(label)})`);
  }
  async function build(deployment: Deployment, label: string) {
    const claim = await claimDeployment(deployment.id, 1);
    assert.ok(claim);
    const commitSha = 'a'.repeat(40);
    assert.equal(await recordDeploymentCommit(deployment.id, claim.token, commitSha), true);
    await writeOutput(label);
    const manifest = await uploadArtifacts(deployment.id, directory, undefined, { token: claim.token, commitSha });
    manifests.push(manifest);
    return activateDeployment(deployment.id, claim.token, commitSha, manifest);
  }
  try {
    await migrate();
    await ensureBucket();
    await mkdir(join(directory, 'assets'));
    const created = await post('/api/projects', { name: 'Serving integration', repoUrl: 'https://github.com/example/fixture.git' });
    assert.equal(created.status, 201);
    const initial = await created.json() as { project: Project; deployment: Deployment };
    project = initial.project;
    deployments.push(initial.deployment);
    // Existing M2 records have root-level artifacts and no worker-attempt token.
    await writeOutput('version one');
    const legacy = await uploadArtifacts(initial.deployment.id, directory);
    manifests.push(legacy);
    await pool.query("UPDATE deployments SET status = 'deployed', commit_sha = $2, started_at = clock_timestamp(), finished_at = clock_timestamp(), artifact_manifest = $3::jsonb WHERE id = $1", [initial.deployment.id, 'a'.repeat(40), JSON.stringify(legacy)]);
    await pool.query('UPDATE projects SET active_deployment_id = $2 WHERE id = $1', [project.id, initial.deployment.id]);
    const original = `/versions/${project.slug}/${initial.deployment.id}/`;
    const firstRedirect = await fetch(`${base}/sites/${project.slug}/`, { redirect: 'manual' });
    assert.equal(firstRedirect.status, 302);
    assert.equal(firstRedirect.headers.get('location'), original);
    assert.equal(firstRedirect.headers.get('cache-control'), 'no-store');
    const firstPage = await fetch(`${base}${original}`);
    assert.match(firstPage.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.match(await firstPage.text(), /version one/);
    const nextResponse = await post(`/api/projects/${project.id}/deployments`, {});
    assert.equal(nextResponse.status, 201);
    const { deployment: second } = await nextResponse.json() as { deployment: Deployment };
    deployments.push(second);
    assert.equal(await build(second, 'version two'), 'active');
    const oldAsset = await fetch(`${base}${original}assets/app.js`);
    assert.equal(oldAsset.headers.get('access-control-allow-origin'), '*');
    assert.equal(await oldAsset.text(), 'console.log("version one")');
    const current = await fetch(`${base}/sites/${project.slug}/`);
    assert.match(await current.text(), /version two/);
    const pendingResponse = await post(`/api/projects/${project.id}/deployments`, {});
    const { deployment: pending } = await pendingResponse.json() as { deployment: Deployment };
    deployments.push(pending);
    assert.equal((await fetch(`${base}/versions/${project.slug}/${pending.id}/`)).status, 404);
    const rollback = await post(`/api/projects/${project.id}/rollback`, { deploymentId: initial.deployment.id });
    assert.equal(rollback.status, 200);
    assert.equal(((await rollback.json()) as { project: Project }).project.activeDeploymentId, initial.deployment.id);
    assert.equal(await build(pending, 'retained version'), 'superseded');
    const restored = await fetch(`${base}/sites/${project.slug}/`);
    assert.match(await restored.text(), /version one/);
    assert.equal((await fetch(`${base}${original}missing.js`)).status, 404);
    assert.equal((await fetch(`${base}${original}__shipyard_manifest.json`)).status, 404);
    assert.equal((await fetch(`${base}/versions/wrong-project/${initial.deployment.id}/`)).status, 404);
    const savedManifest = manifests.find(manifest => manifest.deploymentId === second.id)!;
    const secondPrefix = `deployments/${second.id}/attempts/${savedManifest.attemptId}/`;
    const indexOnly = { ...savedManifest, files: savedManifest.files.filter(file => file.key === 'index.html') };
    indexOnly.totalBytes = indexOnly.files[0].size;
    await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: secondPrefix + '__shipyard_manifest.json', Body: JSON.stringify(indexOnly) }));
    assert.equal((await post(`/api/projects/${project.id}/rollback`, { deploymentId: second.id })).status, 409);
    await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: secondPrefix + '__shipyard_manifest.json', Body: JSON.stringify(savedManifest) }));
    await s3.send(new DeleteObjectsCommand({ Bucket: config.s3Bucket, Delete: { Objects: [{ Key: secondPrefix + 'assets/app.js' }] } }));
    assert.equal((await post(`/api/projects/${project.id}/rollback`, { deploymentId: second.id })).status, 409);
    assert.match(await (await fetch(`${base}/sites/${project.slug}/`)).text(), /version one/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const manifest of manifests) {
      if (manifest.attemptId) await deleteAttemptArtifacts(manifest.deploymentId, manifest.attemptId);
      else await s3.send(new DeleteObjectsCommand({ Bucket: config.s3Bucket, Delete: { Objects: [...manifest.files.map(file => ({ Key: `deployments/${manifest.deploymentId}/${file.key}` })), { Key: `deployments/${manifest.deploymentId}/__shipyard_manifest.json` }] } }));
    }
    for (const deployment of deployments) await queue.remove(`${deployment.id}-1`);
    if (project) {
      await pool.query('UPDATE projects SET active_deployment_id = NULL WHERE id = $1', [project.id]);
      await pool.query('DELETE FROM deployment_logs WHERE deployment_id IN (SELECT id FROM deployments WHERE project_id = $1)', [project.id]);
      await pool.query('DELETE FROM deployments WHERE project_id = $1', [project.id]);
      await pool.query('DELETE FROM projects WHERE id = $1', [project.id]);
    }
    await queue.close();
    await pool.end();
    s3.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
