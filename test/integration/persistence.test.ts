import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, migrate, claimDeployment, activateDeployment, failDeployment, appendLog } from '../../src/db.js';
import { config } from '../../src/config.js';

test('deployment claims are guarded and failed builds preserve the active version', { skip: process.env.RUN_INTEGRATION !== '1' }, async () => {
  const projectId = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  try {
    await migrate();
    await migrate();
    await pool.query('INSERT INTO projects(id, name, slug, repo_url) VALUES ($1, $2, $3, $4)', [projectId, 'Integration test', `integration-${projectId}`, 'https://github.com/example/site.git']);
    await pool.query('INSERT INTO deployments(id, project_id) VALUES ($1, $3), ($2, $3)', [first, second, projectId]);
    assert.equal(await activateDeployment(first, 'a'.repeat(40)), false);
    const claims = await Promise.all([claimDeployment(first), claimDeployment(first)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await activateDeployment(first, 'a'.repeat(40)), true);
    assert.equal(await activateDeployment(first, 'b'.repeat(40)), false);
    assert.equal(await failDeployment(first, 'late failure'), false);
    assert.equal(await claimDeployment(second), 'https://github.com/example/site.git');
    assert.equal(await failDeployment(second, 'npm build failed'), true);
    const project = await pool.query('SELECT active_deployment_id FROM projects WHERE id = $1', [projectId]);
    assert.equal(project.rows[0].active_deployment_id, first);
    await appendLog(second, 'stdout', 'binary\0output');
    const sanitized = await pool.query('SELECT message FROM deployment_logs WHERE deployment_id = $1', [second]);
    assert.equal(sanitized.rows[0].message, 'binary\uFFFDoutput');
    await Promise.all([appendLog(second, 'stdout', 'x'.repeat(config.maxLogBytes)), appendLog(second, 'stderr', 'overflow')]);
    const logs = await pool.query('SELECT log_bytes, log_truncated FROM deployments WHERE id = $1', [second]);
    assert.equal(logs.rows[0].log_bytes, config.maxLogBytes);
    assert.equal(logs.rows[0].log_truncated, true);
    const actual = await pool.query('SELECT coalesce(sum(octet_length(message)), 0)::integer AS bytes FROM deployment_logs WHERE deployment_id = $1', [second]);
    assert.equal(actual.rows[0].bytes, config.maxLogBytes);
  } finally {
    await pool.query('UPDATE projects SET active_deployment_id = NULL WHERE id = $1', [projectId]);
    await pool.query('DELETE FROM deployment_logs WHERE deployment_id IN ($1, $2)', [first, second]);
    await pool.query('DELETE FROM deployments WHERE project_id = $1', [projectId]);
    await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    await pool.end();
  }
});
