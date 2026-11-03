import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/api.js';
import { configureTestAuth, operatorToken } from './auth-fixture.js';

test('API rejects cross-origin writes, form posts and invalid input before persistence', async () => {
  const restoreAuth = configureTestAuth();
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const authenticatedFetch = (url: string, options?: RequestInit) => fetch(url, { ...options, headers: { ...options?.headers, Authorization: `Bearer ${operatorToken}` } });
  try {
    let response = await authenticatedFetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(response.status, 403);
    response = await authenticatedFetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'null' }, body: '{}' });
    assert.equal(response.status, 403);
    response = await authenticatedFetch(`${base}/api/projects`, { method: 'POST', body: 'name=bad' });
    assert.equal(response.status, 415);
    response = await authenticatedFetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(response.status, 400);
    response = await authenticatedFetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', repoUrl: 'http://127.0.0.1/private' }) });
    assert.equal(response.status, 400);
    response = await authenticatedFetch(`${base}/api/projects/not-an-id/deployments`);
    assert.equal(response.status, 400);
    for (const body of [{}, [], null, { deploymentId: 12 }, { deploymentId: 'bad-id' }]) {
      response = await authenticatedFetch(`${base}/api/projects/00000000-0000-0000-0000-000000000001/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
    }
    response = await authenticatedFetch(`${base}/api/projects/not-an-id/rollback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 400);
  } finally { restoreAuth(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
