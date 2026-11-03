import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express, { type ErrorRequestHandler } from 'express';
import { config } from '../../src/config.js';
import { acceptWebhook, configureWebhook, migrate, pool } from '../../src/db.js';
import { deriveWebhookSecret, webhookRouter } from '../../src/webhooks.js';

interface Acknowledgement { accepted: true; duplicate: boolean; deploymentId: string | null }

test('signed GitHub deliveries pin commits, deduplicate persistently and respect per-project secret rotation', { skip: process.env.RUN_INTEGRATION !== '1', timeout: 60_000 }, async () => {
  const { Queue } = await import('bullmq');
  const { queue, queueName, connectionOptions, dispatchQueued } = await import('../../src/queue.js');
  const outboxName = `${queueName}-webhook-integration-${randomUUID()}`;
  const outbox = new Queue(outboxName, { connection: connectionOptions });
  const queueErrors: Error[] = [];
  outbox.on('error', error => queueErrors.push(error));
  const originalKey = config.webhookKey;
  config.webhookKey = 'integration-webhook-master-key-at-least-32-characters';
  const firstProject = randomUUID();
  const secondProject = randomUUID();
  const firstOwner = randomUUID();
  const secondOwner = randomUUID();
  const projects = [firstProject, secondProject];
  const app = express();
  app.use(webhookRouter);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error.status ?? 500).json({ error: 'Request rejected' }); };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const payload = { repository: { full_name: 'eXaMpLe/fIxTuRe' }, ref: 'refs/heads/main', deleted: false, after: 'a'.repeat(40), message: 'नमस्ते 🌊' };
  const raw = JSON.stringify(payload);

  async function send(projectId: string, secret: string, body: string, deliveryId: string = randomUUID(), event = 'push') {
    return fetch(`${base}/api/projects/${projectId}/webhook/github`, {
      method: 'POST', body, signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-github-delivery': deliveryId, 'x-github-event': event, 'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` },
    });
  }
  try {
    await migrate();
    await Promise.all([queue.waitUntilReady(), outbox.waitUntilReady()]);
    for (const [id, owner] of [[firstProject, firstOwner], [secondProject, secondOwner]]) {
      await pool.query('INSERT INTO projects(id, owner_id, name, slug, repo_url) VALUES ($1, $2, $3, $4, $5)', [id, owner, 'Webhook integration', `webhook-${id}`, 'https://github.com/Example/Fixture.git']);
    }
    const first = await configureWebhook(firstProject, firstOwner, true);
    const second = await configureWebhook(secondProject, secondOwner, true);
    assert.ok(first && second);
    const firstSecret = deriveWebhookSecret(firstProject, first.keyVersion);
    const secondSecret = deriveWebhookSecret(secondProject, second.keyVersion);
    assert.notEqual(firstSecret, secondSecret);
    assert.equal((await send(firstProject, 'wrong secret', raw)).status, 401);
    assert.equal((await send(secondProject, firstSecret, raw)).status, 401);
    assert.equal((await send(firstProject, firstSecret, '{')).status, 400);
    assert.equal((await send(firstProject, firstSecret, '[]')).status, 400);
    assert.equal((await send(firstProject, firstSecret, JSON.stringify({ ...payload, repository: { full_name: 'other/repository' } }))).status, 400);
    assert.equal((await send(firstProject, firstSecret, JSON.stringify({ ...payload, after: '0'.repeat(40) }))).status, 400);
    assert.equal((await send(firstProject, firstSecret, JSON.stringify({ ...payload, deleted: 'false' }))).status, 400);

    const deliveryId = randomUUID();
    const responses = await Promise.all([send(firstProject, firstSecret, raw, deliveryId), send(firstProject, firstSecret, raw, deliveryId)]);
    assert.ok(responses.every(response => response.status === 202));
    const accepted = await Promise.all(responses.map(response => response.json() as Promise<Acknowledgement>));
    assert.deepEqual(accepted.map(item => item.duplicate).sort(), [false, true]);
    const deploymentId = accepted[0].deploymentId;
    assert.ok(deploymentId);
    assert.ok(accepted.every(item => item.deploymentId === deploymentId));
    assert.equal(((await (await send(firstProject, firstSecret, raw, deliveryId.toUpperCase())).json()) as Acknowledgement).duplicate, true);
    const pinned = await pool.query('SELECT status, commit_sha, publish_generation FROM deployments WHERE id = $1', [deploymentId]);
    assert.deepEqual(pinned.rows[0], { status: 'queued', commit_sha: payload.after, publish_generation: '1' });
    assert.deepEqual((await queue.getJob(`${deploymentId}-1`))?.data, { deploymentId, expectedAttempt: 1 });
    assert.equal((await pool.query('SELECT count(*)::integer AS count FROM webhook_deliveries WHERE project_id = $1', [firstProject])).rows[0].count, 1);
    assert.equal((await pool.query('SELECT publish_generation FROM projects WHERE id = $1', [firstProject])).rows[0].publish_generation, '1');

    assert.equal((await send(firstProject, firstSecret, JSON.stringify({ ...payload, after: 'b'.repeat(40) }), deliveryId)).status, 409);
    assert.equal((await send(firstProject, firstSecret, raw, deliveryId, 'ping')).status, 409);
    const otherOwner = await send(secondProject, secondSecret, raw, deliveryId);
    assert.equal(otherOwner.status, 202);
    assert.notEqual(((await otherOwner.json()) as Acknowledgement).deploymentId, deploymentId);

    for (const [body, event] of [
      [JSON.stringify({ ...payload, ref: 'refs/heads/feature' }), 'push'],
      [JSON.stringify({ ...payload, deleted: true, after: '0'.repeat(40) }), 'push'],
      [JSON.stringify({ repository: payload.repository }), 'ping'],
      [JSON.stringify({ repository: payload.repository, action: 'opened' }), 'issues'],
    ]) {
      const ignoredId = randomUUID();
      const ignored = await send(firstProject, firstSecret, body, ignoredId, event);
      assert.equal(ignored.status, 202);
      assert.deepEqual(await ignored.json(), { accepted: true, duplicate: false, deploymentId: null });
      assert.deepEqual(await (await send(firstProject, firstSecret, body, ignoredId, event)).json(), { accepted: true, duplicate: true, deploymentId: null });
    }
    assert.equal((await pool.query('SELECT publish_generation FROM projects WHERE id = $1', [firstProject])).rows[0].publish_generation, '1');

    await queue.remove(`${deploymentId}-1`);
    assert.equal(await queue.getJob(`${deploymentId}-1`), undefined);
    await dispatchQueued(outbox);
    assert.deepEqual((await outbox.getJob(`${deploymentId}-1`))?.data, { deploymentId, expectedAttempt: 1 });
    assert.equal((await pool.query('SELECT commit_sha FROM deployments WHERE id = $1', [deploymentId])).rows[0].commit_sha, payload.after);

    const rotated = await configureWebhook(firstProject, firstOwner, true);
    assert.ok(rotated);
    const rotatedSecret = deriveWebhookSecret(firstProject, rotated.keyVersion);
    assert.notEqual(rotatedSecret, firstSecret);
    assert.equal((await send(firstProject, firstSecret, raw)).status, 401);
    assert.equal(await acceptWebhook(firstProject, first.keyVersion, randomUUID(), createHash('sha256').update(raw).digest('hex'), 'push', payload.after), 'disabled');
    assert.equal((await send(firstProject, rotatedSecret, raw)).status, 202);
    await configureWebhook(firstProject, firstOwner, false);
    assert.equal((await send(firstProject, rotatedSecret, raw)).status, 404);
    assert.deepEqual(queueErrors, []);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    config.webhookKey = originalKey;
    const deployments = await pool.query<{ id: string }>('SELECT id FROM deployments WHERE project_id = ANY($1::uuid[])', [projects]);
    for (const { id } of deployments.rows) await queue.remove(`${id}-1`);
    assert.ok(outboxName.startsWith(`${queueName}-webhook-integration-`));
    await outbox.obliterate({ force: true });
    await outbox.close();
    await queue.close();
    await pool.query('DELETE FROM deployment_logs WHERE deployment_id IN (SELECT id FROM deployments WHERE project_id = ANY($1::uuid[]))', [projects]);
    await pool.query('DELETE FROM deployments WHERE project_id = ANY($1::uuid[])', [projects]);
    await pool.query('DELETE FROM projects WHERE id = ANY($1::uuid[])', [projects]);
    await pool.end();
  }
});
