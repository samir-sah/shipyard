import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { pool, migrate, createDeployment, claimDeployment, recoverExpiredClaims, failDeployment } from '../../src/db.js';
import { config } from '../../src/config.js';

test('Redis duplicate delivery, retained jobs and lost jobs reconcile with persisted attempts', { skip: process.env.RUN_INTEGRATION !== '1' || config.maxBuildAttempts < 3, timeout: 30_000 }, async () => {
  const { queue, queueName, connectionOptions, enqueueDeployment, dispatchQueued } = await import('../../src/queue.js');
  const isolatedName = `${queueName}-integration-${randomUUID()}`;
  const isolated = new Queue(isolatedName, { connection: connectionOptions });
  let worker: Worker | undefined;
  let workerError: unknown;
  const project = randomUUID();
  let id: string | undefined;
  try {
    await migrate();
    await Promise.all([queue.waitUntilReady(), isolated.waitUntilReady()]);
    await pool.query('INSERT INTO projects(id,name,slug,repo_url) VALUES ($1,$2,$3,$4)', [project, 'Queue integration', `queue-${project}`, 'https://github.com/example/fixture.git']);
    const deployment = await createDeployment(project);
    assert.ok(deployment);
    id = deployment.id;
    await Promise.all([enqueueDeployment(id, isolated), enqueueDeployment(id, isolated)]);
    assert.equal(await isolated.getWaitingCount(), 1);
    assert.equal((await isolated.getJob(`${id}-1`))?.data.expectedAttempt, 1);
    const claims = await Promise.all([claimDeployment(id, 1), claimDeployment(id, 1)]);
    assert.equal(claims.filter(Boolean).length, 1);
    await pool.query("UPDATE deployments SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);
    await recoverExpiredClaims();
    await pool.query('UPDATE deployments SET retry_at=clock_timestamp() WHERE id=$1', [id]);
    await enqueueDeployment(id, isolated);
    assert.ok(await isolated.getJob(`${id}-1`));
    assert.equal((await isolated.getJob(`${id}-2`))?.data.expectedAttempt, 2);
    assert.equal(await claimDeployment(id, 1), null);
    const second = await claimDeployment(id, 2);
    assert.ok(second);
    assert.equal(await failDeployment(id, second.token, 'Retry fixture'), 'retry');
    await pool.query('UPDATE deployments SET retry_at=clock_timestamp() WHERE id=$1', [id]);
    await enqueueDeployment(id, isolated);
    // This isolated worker acknowledges jobs without claiming DB work, modeling a lost processing step.
    worker = new Worker(isolatedName, async () => {}, { connection: { ...connectionOptions, maxRetriesPerRequest: null, enableOfflineQueue: true } });
    worker.on('error', error => { workerError = error; });
    const deadline = Date.now() + 5_000;
    while (await (await isolated.getJob(`${id}-3`))?.getState() !== 'completed') {
      if (workerError) throw workerError;
      if (Date.now() > deadline) throw new Error('Isolated queue worker did not complete');
      await delay(25);
    }
    await worker.close();
    worker = undefined;
    await enqueueDeployment(id, isolated);
    assert.equal(await (await isolated.getJob(`${id}-3`))?.getState(), 'waiting');
    await isolated.remove(`${id}-3`);
    await dispatchQueued(isolated);
    assert.equal((await isolated.getJob(`${id}-3`))?.data.expectedAttempt, 3);
    const third = await claimDeployment(id, 3);
    assert.ok(third);
    assert.equal(await claimDeployment(id, 3), null);
  } finally {
    await worker?.close();
    assert.ok(isolatedName.startsWith(`${queueName}-integration-`));
    await isolated.obliterate({ force: true });
    await isolated.close();
    await queue.close();
    if (id) await pool.query('DELETE FROM deployment_logs WHERE deployment_id=$1', [id]);
    await pool.query('DELETE FROM deployments WHERE project_id=$1', [project]);
    await pool.query('DELETE FROM projects WHERE id=$1', [project]);
    await pool.end();
  }
});
