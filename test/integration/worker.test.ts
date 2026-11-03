import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { migrate, pool, createDeployment, claimDeployment, recoverExpiredClaims } from '../../src/db.js';
import { s3, ensureBucket, getArtifact } from '../../src/storage.js';
import { deploy } from '../../src/deployment.js';
import { cleanupBuildResources } from '../../src/cleanup.js';
import { containerArguments } from '../../src/build.js';
import { runCommand } from '../../src/process.js';
import { config } from '../../src/config.js';
import type { ArtifactManifest } from '../../src/contracts.js';

test('worker upload crashes recover without publishing an abandoned attempt', { skip: process.env.RUN_INTEGRATION !== '1', timeout: 120_000 }, async t => {
  const projects: string[] = [];
  const ids: string[] = [];
  const directories: string[] = [];
  let child: ChildProcess | undefined;
  async function create() {
    const project = randomUUID();
    projects.push(project);
    await pool.query('INSERT INTO projects(id,name,slug,repo_url) VALUES ($1,$2,$3,$4)', [project, 'Worker recovery', `worker-${project}`, 'https://github.com/example/fixture.git']);
    const deployment = await createDeployment(project);
    assert.ok(deployment);
    ids.push(deployment.id);
    return { project, deployment };
  }
  async function expiry(id: string) {
    await pool.query("UPDATE deployments SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [id]);
    await recoverExpiredClaims();
    await pool.query('UPDATE deployments SET retry_at = clock_timestamp() WHERE id=$1', [id]);
  }
  try {
    await migrate();
    await ensureBucket();
    for (const phase of ['object', 'manifest']) await t.test(`SIGKILL after storing ${phase} preserves one deployment and retries on a fresh claim`, async () => {
      const { project, deployment } = await create();
      child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/crash-worker.ts', deployment.id, phase], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      const uploaded = await new Promise<{ key: string; workspace: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Crash fixture did not upload: ${stderr}`)), 20_000);
        child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Crash fixture exited ${code}: ${stderr}`)); });
        child!.once('error', error => { clearTimeout(timer); reject(error); });
        child!.stdout!.on('data', chunk => {
          stdout += chunk;
          let newline: number;
          while ((newline = stdout.indexOf('\n')) >= 0) {
            const line = stdout.slice(0, newline);
            stdout = stdout.slice(newline + 1);
            if (!line.startsWith('{')) continue;
            const event = JSON.parse(line);
            if (event.event === 'uploaded') { clearTimeout(timer); resolve(event); return; }
          }
        });
      });
      directories.push(uploaded.workspace);
      const old = (await pool.query('SELECT claim_token,commit_sha FROM deployments WHERE id=$1', [deployment.id])).rows[0];
      assert.equal(old.commit_sha, 'a'.repeat(40));
      assert.ok(uploaded.key.includes(`/attempts/${old.claim_token}/`));
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      child = undefined;
      assert.equal((await pool.query('SELECT active_deployment_id FROM projects WHERE id=$1', [project])).rows[0].active_deployment_id, null);
      await expiry(deployment.id);
      await deploy(deployment.id, 2, async (_id, token, _url, pinned, _log, publish, signal) => {
        assert.notEqual(token, old.claim_token);
        assert.equal(pinned, 'a'.repeat(40));
        const directory = await mkdtemp(join(tmpdir(), 'shipyard-retry-'));
        directories.push(directory);
        await writeFile(join(directory, 'index.html'), '<h1>Recovered</h1>');
        await publish(directory, pinned!, signal!);
      });
      const row = (await pool.query('SELECT status,artifact_manifest,attempt_count FROM deployments WHERE id=$1', [deployment.id])).rows[0];
      const manifest = row.artifact_manifest as ArtifactManifest;
      assert.equal(row.status, 'deployed');
      assert.equal(row.attempt_count, 2);
      assert.notEqual(manifest.attemptId, old.claim_token);
      assert.equal(await (await getArtifact(deployment.id, 'index.html', manifest.attemptId)).Body?.transformToString(), '<h1>Recovered</h1>');
      assert.equal((await pool.query('SELECT active_deployment_id FROM projects WHERE id=$1', [project])).rows[0].active_deployment_id, deployment.id);
      await cleanupBuildResources();
      const abandoned = await s3.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: `deployments/${deployment.id}/attempts/${old.claim_token}/` }));
      assert.equal(abandoned.Contents?.length ?? 0, 0);
      await assert.rejects(access(uploaded.workspace));
      await deploy(deployment.id, 1, async () => { throw new Error('Stale job must not execute'); });
      await deploy(deployment.id, 2, async () => { throw new Error('Completed job must not execute'); });
    });
    await t.test('heartbeat claim loss cancels an in-progress build', async () => {
      const { project, deployment } = await create();
      const previousLease = config.workerLeaseMs;
      config.workerLeaseMs = 600;
      try {
        await assert.rejects(deploy(deployment.id, 1, async (_id, _token, _url, _pin, _log, _publish, signal) => {
          await pool.query("UPDATE deployments SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [deployment.id]);
          const cancellation = AbortSignal.any([signal!, AbortSignal.timeout(5_000)]);
          await new Promise((_, reject) => {
            if (cancellation.aborted) reject(cancellation.reason);
            else cancellation.addEventListener('abort', () => reject(cancellation.reason), { once: true });
          });
        }), /Worker claim expired or changed/);
      } finally { config.workerLeaseMs = previousLease; }
      assert.equal((await pool.query('SELECT active_deployment_id FROM projects WHERE id=$1', [project])).rows[0].active_deployment_id, null);
    });
    await t.test('labeled Docker resources survive active claims and are collected after expiry', { skip: process.env.RUN_DOCKER_TESTS !== '1' }, async () => {
      const { deployment } = await create();
      const claim = await claimDeployment(deployment.id, 1);
      assert.ok(claim);
      const volume = `shipyard-work-${claim.token}`;
      const name = `shipyard-${deployment.id}-${claim.token}`;
      const root = join(tmpdir(), 'shipyard-builds');
      await mkdir(root, { recursive: true });
      const workspace = await mkdtemp(join(root, `${claim.token}-`));
      directories.push(workspace);
      const docker = (args: string[]) => runCommand('docker', args, { timeoutMs: 20_000 });
      await docker(['volume', 'create', '--label', 'shipyard.managed=true', '--label', `shipyard.claim=${claim.token}`, volume]);
      const args = containerArguments(deployment.id, claim.token, claim.repoUrl);
      const imageIndex = args.indexOf(config.buildImage);
      args.splice(imageIndex + 1, args.length, '--signal=TERM', '--kill-after=1s', '0.1s', '/bin/sh', '-c', 'sleep 60');
      await docker(args);
      const container = JSON.parse(await docker(['inspect', name]))[0];
      assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.equal(container.HostConfig.Memory, config.buildMemoryMb * 1024 * 1024);
      assert.equal(container.HostConfig.MemorySwap, container.HostConfig.Memory);
      assert.equal(container.HostConfig.NanoCpus, config.buildCpus * 1_000_000_000);
      assert.equal(container.HostConfig.PidsLimit, config.buildPids);
      assert.ok(!JSON.stringify(container.Mounts).includes('docker.sock'));
      await docker(['start', '--attach', name]).catch(() => {});
      const stopped = JSON.parse(await docker(['inspect', name]))[0];
      assert.equal(stopped.State.Running, false);
      assert.equal(stopped.State.ExitCode, 124, 'Container deadline must survive loss of its worker');
      await cleanupBuildResources();
      await docker(['inspect', name]);
      await access(workspace);
      await expiry(deployment.id);
      await cleanupBuildResources();
      await assert.rejects(docker(['inspect', name]));
      await assert.rejects(docker(['volume', 'inspect', volume]));
      await assert.rejects(access(workspace));
    });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    for (const id of ids) {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: `deployments/${id}/` }));
      if (page.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: config.s3Bucket, Delete: { Objects: page.Contents.map(object => ({ Key: object.Key! })) } }));
    }
    if (projects.length) {
      await pool.query('UPDATE projects SET active_deployment_id=NULL WHERE id=ANY($1::uuid[])', [projects]);
      await pool.query('DELETE FROM deployment_logs WHERE deployment_id IN (SELECT id FROM deployments WHERE project_id=ANY($1::uuid[]))', [projects]);
      await pool.query('DELETE FROM deployments WHERE project_id=ANY($1::uuid[])', [projects]);
      await pool.query('DELETE FROM projects WHERE id=ANY($1::uuid[])', [projects]);
    }
    for (const directory of directories) {
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep), 'Refuse cleanup outside temporary files');
      await rm(directory, { recursive: true, force: true });
    }
    await pool.end();
    s3.destroy();
  }
});
