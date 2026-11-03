import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, statfs, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import type { Deployment, Project } from '../src/contracts.js';
import { pool } from '../src/db.js';
import { parseArtifactManifest, s3 } from '../src/storage.js';

export function summarize(values: number[]) {
  assert.ok(values.every(value => Number.isFinite(value) && value >= 0), 'Metrics must be finite and nonnegative');
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  return { samples: count, median: count ? (sorted[Math.floor((count - 1) / 2)] + sorted[Math.floor(count / 2)]) / 2 : null,
    p95: count ? sorted[Math.ceil(count * 0.95) - 1] : null };
}

export function maxClaimOverlap(attempts: Array<{ startedAt: Date; finishedAt: Date | null }>) {
  const events: Array<[number, number]> = [];
  for (const attempt of attempts) {
    assert.ok(attempt.finishedAt, 'Only terminal attempts belong in the overlap result');
    const start = attempt.startedAt.getTime();
    const finish = attempt.finishedAt.getTime();
    assert.ok(Number.isFinite(start) && Number.isFinite(finish) && finish >= start);
    if (finish > start) events.push([start, 1], [finish, -1]);
  }
  let current = 0;
  let maximum = 0;
  for (const [, change] of events.sort((a, b) => a[0] - b[0] || a[1] - b[1])) maximum = Math.max(maximum, current += change);
  return maximum;
}

const repo = 'https://github.com/adrianhajdin/nike_landing_page.git';
const reviewedSha = 'cfda8c5841b6e57f644f19aa10c4329553162a15';
const base = 'http://localhost:3000';
type Submitted = { project: Project; deployment: Deployment };
interface Attempt { deploymentId: string; attempt: number; status: string; startedAt: Date; finishedAt: Date | null; operationalMs: number | null }

async function main() {
  const token: unknown = process.env.SHIPYARD_TOKEN || JSON.parse(process.env.AUTH_USERS || '[]')[0]?.token;
  assert.ok(typeof token === 'string', 'Provide SHIPYARD_TOKEN or load generated AUTH_USERS from .env');
  assert.equal(config.retentionDays, 0, 'Use disposable services with new retention disabled');
  const deadline = Date.now() + 10 * 60_000;
  const runSignal = AbortSignal.timeout(10 * 60_000);
  const requestSignal = () => AbortSignal.any([runSignal, AbortSignal.timeout(15_000)]);
  function command(file: string, args: string[]) {
    runSignal.throwIfAborted();
    return execFileSync(file, args, { encoding: 'utf8', timeout: Math.max(1, Math.min(30_000, deadline - Date.now())) }).trim();
  }
  async function api<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: requestSignal(),
    });
    assert.ok(response.ok, `Owner API ${path} returned ${response.status}`);
    return await response.json() as T;
  }
  async function submit(label: string): Promise<Submitted> {
    assert.ok(Date.now() < deadline, 'Benchmark deadline reached before submission');
    return await api<Submitted>('/api/projects', { name: `Benchmark ${label} ${randomUUID()}`, repoUrl: repo });
  }
  async function wait(submitted: Submitted[]) {
    const pending = new Map(submitted.map(item => [item.deployment.id, item]));
    while (pending.size) {
      assert.ok(Date.now() < deadline, 'Benchmark timed out; deployments may still be running');
      for (const [id, item] of pending) {
        const { deployments } = await api<{ deployments: Deployment[] }>(`/api/projects/${item.project.id}/deployments`);
        const deployment = deployments.find(value => value.id === id);
        assert.ok(deployment, 'Deployment must remain in persisted history');
        item.deployment = deployment;
        if (['failed', 'deployed'].includes(deployment.status)) {
          pending.delete(id);
          console.log(`${item.project.name}: ${deployment.status}, attempts=${deployment.attemptCount}`);
        }
      }
      if (pending.size) await delay(1_000, undefined, { signal: runSignal });
    }
  }
  async function sample(item: Submitted) {
    runSignal.throwIfAborted();
    const deployment = item.deployment;
    const result = await pool.query<{ artifact_manifest: unknown; endToEndMs: number }>(
      'SELECT artifact_manifest, (extract(epoch FROM (finished_at-created_at))*1000)::float8 AS "endToEndMs" FROM deployments WHERE id=$1', [deployment.id]);
    let output: { files: number; bytes: number } | null = null;
    let activated = false;
    if (deployment.status === 'deployed') {
      assert.equal(deployment.commitSha, reviewedSha, 'Fixture main changed; review before updating the pin');
      const manifest = parseArtifactManifest(result.rows[0]?.artifact_manifest, deployment.id);
      assert.equal(manifest.commitSha, reviewedSha);
      const { projects } = await api<{ projects: Project[] }>('/api/projects');
      activated = projects.find(project => project.id === item.project.id)?.activeDeploymentId === deployment.id;
      assert.ok(activated, 'The only deployment for its new project must activate');
      for (const file of manifest.files) {
        const path = file.key.split('/').map(encodeURIComponent).join('/');
        const response = await fetch(`${base}/versions/${item.project.slug}/${deployment.id}/${path}`, { signal: requestSignal() });
        assert.equal(response.status, 200, `Published file ${file.key}`);
        const body = Buffer.from(await response.arrayBuffer());
        assert.equal(body.length, file.size, file.key);
        assert.equal(createHash('sha256').update(body).digest('hex'), file.sha256, file.key);
      }
      output = { files: manifest.files.length, bytes: manifest.totalBytes };
    }
    const attempts = await pool.query<Attempt>(`SELECT deployment_id AS "deploymentId", attempt_number AS attempt, status,
      started_at AS "startedAt", finished_at AS "finishedAt",
      (extract(epoch FROM (finished_at-started_at))*1000)::float8 AS "operationalMs"
      FROM build_attempts WHERE deployment_id=$1 ORDER BY attempt_number`, [deployment.id]);
    assert.equal(attempts.rows.length, deployment.attemptCount);
    return { deploymentId: deployment.id, projectId: item.project.id, status: deployment.status,
      commitSha: deployment.commitSha, createdAt: deployment.createdAt, startedAt: deployment.startedAt, finishedAt: deployment.finishedAt,
      queueWaitMs: deployment.queueWaitMs, buildDurationMs: deployment.buildDurationMs, endToEndMs: result.rows[0].endToEndMs,
      activated, output, attempts: attempts.rows };
  }

  try {
    const workerIds = command('docker', ['compose', 'ps', '-q', 'worker']).split(/\s+/).filter(Boolean);
    assert.equal(workerIds.length, 1, 'Run exactly one worker process for this comparison');
    const actualConcurrency = Number(command('docker', ['compose', 'exec', '-T', 'worker', 'node', '-p', 'process.env.WORKER_CONCURRENCY']));
    assert.equal(actualConcurrency, config.workerConcurrency, 'Runner and running worker concurrency must match');
    const busy = await pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM deployments WHERE status IN ('queued','building')");
    assert.equal(busy.rows[0].count, 0, 'Start from an idle disposable platform');
    const lock = await fetch(`https://raw.githubusercontent.com/adrianhajdin/nike_landing_page/${reviewedSha}/package-lock.json`, { signal: requestSignal() });
    assert.equal(lock.status, 200);
    const lockSha256 = createHash('sha256').update(Buffer.from(await lock.arrayBuffer())).digest('hex');

    const baseline = await submit('fresh-cache');
    await wait([baseline]);
    const baselineSample = await sample(baseline);
    const warmup = await submit('warmup');
    await wait([warmup]);
    const warmupSample = await sample(warmup);
    const submitted: Submitted[] = [];
    const submissionStart = performance.now();
    for (let index = 0; index < 5; index++) submitted.push(await submit(`sample-${index + 1}`));
    const submissionWindowMs = performance.now() - submissionStart;
    await wait(submitted);
    const samples = [];
    for (const item of submitted) samples.push(await sample(item));
    const ids = submitted.map(item => item.deployment.id);
    const window = await pool.query<{ elapsedMs: number }>(
      'SELECT (extract(epoch FROM (max(finished_at)-min(created_at)))*1000)::float8 AS "elapsedMs" FROM deployments WHERE id=ANY($1::uuid[])', [ids]);
    const elapsedMs = window.rows[0].elapsedMs;
    assert.ok(elapsedMs > 0);
    const successes = samples.filter(value => value.status === 'deployed');
    const attempts = samples.flatMap(value => value.attempts);
    const disk = await statfs('.');
    const report = {
      kind: 'five-request burst on one worker; small-sample comparison, not sustained capacity',
      recordedAt: new Date().toISOString(), platformSha: command('git', ['rev-parse', 'HEAD']),
      fixture: { repo, reviewedSha, lockSha256 },
      workload: { baseline: 'One fresh work volume and npm cache, not a cold image/host', warmups: 1, measuredRequests: 5,
        submission: 'Five sequential authenticated project-create requests without delay, one deployment per new project', submissionWindowMs,
        users: config.authUsers.length, workerProcesses: workerIds.length, configuredConcurrency: actualConcurrency,
        cache: 'Every attempt uses a new work volume/npm cache; image/runtime layers already warm; network/registry/storage caches uncontrolled',
        otherProcesses: 'API, PostgreSQL, Redis, SeaweedFS, runner and worker maintenance; other host activity uncontrolled',
        https: false, retentionDays: config.retentionDays },
      baseline: baselineSample, warmup: warmupSample, samples,
      summary: { submitted: samples.length, successes: successes.length, terminalFailures: samples.filter(value => value.status === 'failed').length,
        activePointerChanges: samples.filter(value => value.activated).length,
        completedAttempts: attempts.filter(value => value.status === 'completed').length,
        failedAttempts: attempts.filter(value => value.status === 'failed').length, expiredAttempts: attempts.filter(value => value.status === 'expired').length,
        retries: attempts.length - samples.length, maxSimultaneousClaims: maxClaimOverlap(attempts),
        claimOverlapMeaning: 'Ledger operational intervals, millisecond timestamp resolution; not simultaneous Docker container counts',
        elapsedMs, window: 'Earliest measured deployment creation to latest terminal finish in PostgreSQL',
        successfulDeploymentsPerMinute: successes.length * 60_000 / elapsedMs,
        activePointerChangesPerMinute: samples.filter(value => value.activated).length * 60_000 / elapsedMs,
        queueWaitMs: summarize(successes.map(value => value.queueWaitMs!)),
        buildDurationMs: summarize(successes.map(value => value.buildDurationMs!)),
        endToEndMs: summarize(successes.map(value => value.endToEndMs)),
        percentiles: 'Median averages the two central samples when even; p95 is nearest rank, ceil(0.95*n). With five samples p95 equals the maximum; no population claim.' },
      environment: { os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), hostNode: process.version,
        docker: command('docker', ['version', '--format', '{{.Server.Version}}']),
        compose: command('docker', ['compose', 'version', '--short']),
        dockerAllocation: JSON.parse(command('docker', ['info', '--format', '{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}}}'])),
        builderNode: command('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node', config.buildImage, '--version']),
        builderNpm: command('docker', ['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'npm', config.buildImage, '--version']),
        disk: { capacityBytes: disk.blocks * disk.bsize, availableBytesAfterRun: disk.bavail * disk.bsize, type: 'Unmeasured' } },
      limits: { cpus: config.buildCpus, memoryMb: config.buildMemoryMb, pids: config.buildPids,
        timeoutMs: config.buildTimeoutMs, leaseMs: config.workerLeaseMs, maxAttempts: config.maxBuildAttempts },
      unchecked: ['sustained supported capacity', 'peak CPU/memory and simultaneous Docker container counts', 'failure/recovery workload timing',
        'restore/webhook/retention latency', 'browser and DNS/TLS/proxy', 'network bandwidth and cache state'],
    };
    await mkdir('.tmp', { recursive: true });
    const path = `.tmp/benchmark-${actualConcurrency}.json`;
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ path, summary: report.summary }, null, 2));
    assert.equal(baselineSample.status, 'deployed', 'Baseline failed; results saved');
    assert.equal(warmupSample.status, 'deployed', 'Warmup failed; results saved');
    assert.equal(successes.length, samples.length, 'Measured deployment failures occurred; results saved');
  } finally {
    await pool.end();
    s3.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
