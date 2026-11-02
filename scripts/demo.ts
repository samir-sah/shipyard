import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { Deployment, Project, DeploymentLog } from '../src/contracts.js';

const { values } = parseArgs({ options: {
  repo: { type: 'string' }, project: { type: 'string' }, name: { type: 'string', default: 'Shipyard demo' },
  base: { type: 'string', default: 'http://localhost:3000' },
  duplicate: { type: 'boolean', default: false }, 'expect-failure': { type: 'boolean', default: false },
} });
if (Boolean(values.repo) === Boolean(values.project)) throw new Error('Provide exactly one of --repo URL or --project ID');
const base = values.base!.replace(/\/$/, '');
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(result)}`);
  return result as T;
}

const before = await api<{ projects: Project[] }>('/api/projects');
let project: Project;
let deployment: Deployment;
let previousActive: string | null = null;
if (values.project) {
  const existing = before.projects.find(item => item.id === values.project);
  assert.ok(existing, 'Project must appear in the dashboard project list');
  project = existing;
  previousActive = project.activeDeploymentId;
  ({ deployment } = await api<{ deployment: Deployment }>(`/api/projects/${project.id}/deployments`, {}));
} else {
  ({ project, deployment } = await api<{ project: Project; deployment: Deployment }>('/api/projects', { name: values.name, repoUrl: values.repo }));
}
console.log(`Project ${project.id}, deployment ${deployment.id}`);
if (values.duplicate) {
  const { enqueueDeployment, queue } = await import('../src/queue.js');
  try { await enqueueDeployment(deployment.id); await enqueueDeployment(deployment.id); }
  finally { await queue.close(); }
  console.log('Delivered the same deployment job twice more.');
}
let cursor = 0;
const deadline = Date.now() + 15 * 60_000;
while (true) {
  const logs = await api<{ logs: DeploymentLog[]; nextCursor: number }>(`/api/deployments/${deployment.id}/logs?after=${cursor}`);
  for (const line of logs.logs) process.stdout.write(`[${line.stream}] ${line.message}`);
  cursor = logs.nextCursor;
  const history = await api<{ deployments: Deployment[] }>(`/api/projects/${project.id}/deployments`);
  const current = history.deployments.find(item => item.id === deployment.id);
  assert.ok(current, 'Deployment must remain in persisted history');
  deployment = current;
  if (['failed', 'deployed'].includes(deployment.status)) break;
  if (Date.now() > deadline) throw new Error('Demo timed out; inspect API and worker logs');
  await delay(1_000);
}
const after = await api<{ projects: Project[] }>('/api/projects');
const active = after.projects.find(item => item.id === project.id)?.activeDeploymentId;
if (values['expect-failure']) {
  assert.equal(deployment.status, 'failed', deployment.error ?? 'Expected a failed build');
  assert.equal(active, previousActive, 'Failed build must preserve the previous active version');
} else {
  assert.equal(deployment.status, 'deployed', deployment.error ?? 'Expected a successful build');
  assert.equal(active, deployment.id);
}
if (active) {
  const site = await fetch(`${base}/sites/${project.slug}/`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(site.status, 200, 'Active site must remain available');
  assert.match(site.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.ok((await site.text()).length > 0);
}
console.log(JSON.stringify({ deploymentId: deployment.id, status: deployment.status, queueWaitMs: deployment.queueWaitMs, buildDurationMs: deployment.buildDurationMs, site: active ? `${base}/sites/${project.slug}/` : null }, null, 2));
