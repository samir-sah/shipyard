import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { config } from '../src/config.js';
import type { Deployment, Project } from '../src/contracts.js';
import { pool } from '../src/db.js';
import { parseArtifactManifest, s3 } from '../src/storage.js';
import { httpFetch } from '../test/http.js';

// This fixture must be reviewed again when its main branch changes.
const repo = 'https://github.com/adrianhajdin/nike_landing_page.git';
const reviewedSha = 'cfda8c5841b6e57f644f19aa10c4329553162a15';
const base = 'http://localhost:3000';
const name = `Public Vite smoke ${randomUUID()}`;
const token: unknown = JSON.parse(process.env.AUTH_USERS || '[]')[0]?.token;
assert.ok(typeof token === 'string', 'Run npm run setup and load .env before the public demo');

async function api<T>(path: string): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200, `Owner API ${path}`);
  return await response.json() as T;
}
function command(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: 'utf8', timeout: 30_000 }).trim();
}

try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo.ts', '--repo', repo, '--name', name, '--duplicate'], {
      env: { ...process.env, SHIPYARD_TOKEN: token }, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Demo exited ${code ?? signal}`)));
  });

  const { projects } = await api<{ projects: Project[] }>('/api/projects');
  const matches = projects.filter(project => project.name === name);
  assert.equal(matches.length, 1);
  const project = matches[0];
  const { deployments } = await api<{ deployments: Deployment[] }>(`/api/projects/${project.id}/deployments`);
  assert.equal(deployments.length, 1, 'Duplicate queue delivery must not create extra deployments');
  const deployment = deployments[0];
  assert.equal(deployment.status, 'deployed');
  assert.equal(project.activeDeploymentId, deployment.id);
  assert.equal(deployment.commitSha, reviewedSha, 'Fixture main changed: review the new commit before updating the pin');
  assert.ok(deployment.attemptCount >= 1 && deployment.attemptCount <= config.maxBuildAttempts);
  const stored = await pool.query<{ artifact_manifest: unknown }>('SELECT artifact_manifest FROM deployments WHERE id = $1', [deployment.id]);
  const manifest = parseArtifactManifest(stored.rows[0]?.artifact_manifest, deployment.id);
  assert.equal(manifest.commitSha, reviewedSha);
  assert.ok(manifest.attemptId);

  assert.ok(project.siteUrl, 'API must expose the project origin');
  const host = new URL(project.siteUrl).host;
  const routes = [
    { root: `/sites/${project.slug}/`, version: `/versions/${project.slug}/${deployment.id}/`, headers: new Headers() },
    { root: '/', version: `/_shipyard/v/${deployment.id}/`, headers: new Headers({ Host: host }) },
  ];
  for (const route of routes) {
    const redirect = await httpFetch(`${base}${route.root}`, { headers: route.headers });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), route.version);
    for (const file of manifest.files) {
      const path = file.key.split('/').map(encodeURIComponent).join('/');
      const response = await httpFetch(`${base}${route.version}${path}`, { headers: route.headers });
      assert.equal(response.status, 200, file.key);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.length, file.size, file.key);
      assert.equal(createHash('sha256').update(body).digest('hex'), file.sha256, file.key);
      if (file.key !== 'index.html') continue;
      if (route.root === '/') {
        assert.match(response.headers.get('content-security-policy') ?? '', /object-src 'none'/);
        assert.doesNotMatch(response.headers.get('content-security-policy') ?? '', /sandbox/);
      }
      else assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
      // The reviewed Vite fixture has a simple static entry; browser execution is a separate check.
      const references = [...body.toString('utf8').matchAll(/(?:src|href)=["']([^"']+)["']/g)];
      assert.ok(references.length > 0, 'Expected Vite entry asset references');
      for (const [, reference] of references) {
        const resolved = new URL(reference, `${base}${route.version}`);
        assert.equal(resolved.origin, base, reference);
        assert.ok(resolved.pathname.startsWith(route.version), `Asset escaped pinned version: ${reference}`);
        const key = decodeURIComponent(resolved.pathname.slice(route.version.length));
        assert.ok(manifest.files.some(item => item.key === key), `Entry asset absent: ${reference}`);
      }
    }
  }

  const evidence = {
    kind: 'single functional public Git-to-site smoke; not a capacity benchmark',
    recordedAt: new Date().toISOString(), platformSha: command('git', ['rev-parse', 'HEAD']),
    fixture: { repo, reviewedSha, deployedSha: deployment.commitSha },
    deployment: { id: deployment.id, projectId: project.id, status: deployment.status,
      createdAt: deployment.createdAt, startedAt: deployment.startedAt, finishedAt: deployment.finishedAt,
      queueWaitMs: deployment.queueWaitMs, buildDurationMs: deployment.buildDurationMs, attemptCount: deployment.attemptCount,
      files: manifest.files.length, bytes: manifest.totalBytes, attemptId: manifest.attemptId },
    checks: ['duplicate enqueue calls (claim/delivery fencing is covered separately by integration tests)', 'active selection', 'reviewed commit', 'manifest identity',
      'both pinned routes: every file size and SHA-256', 'entry asset references remain pinned', 'project host and fallback CSP'],
    environment: { os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
      memoryBytes: totalmem(), hostNode: process.version,
      docker: command('docker', ['version', '--format', '{{.Server.Version}}']),
      compose: command('docker', ['compose', 'version', '--short']),
      builderNode: command('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', config.buildImage, '--version']),
      cache: 'Fresh per-attempt work volume and npm cache; Docker image layers already built; network/storage caches uncontrolled' },
    limits: { workerProcesses: 1, workerConcurrency: config.workerConcurrency, cpus: config.buildCpus,
      memoryMb: config.buildMemoryMb, pids: config.buildPids, timeoutMs: config.buildTimeoutMs,
      leaseMs: config.workerLeaseMs, maxAttempts: config.maxBuildAttempts },
    unchecked: ['browser JavaScript execution and visual layout', 'wildcard DNS', 'HTTPS/proxy', 'capacity and percentiles'],
  };
  await mkdir('.tmp', { recursive: true });
  await writeFile('.tmp/public-demo.json', `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await pool.end();
  s3.destroy();
}
