import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/api.js';
import { config } from '../src/config.js';
import { configureTestAuth, operatorToken } from './auth-fixture.js';
import { httpFetch as fetch } from './http.js';

test('site and unknown hosts cannot reach dashboard APIs; forwarded host does not override routing', async () => {
  const restoreAuth = configureTestAuth();
  const key = config.webhookKey;
  config.webhookKey = 'test-only-webhook-key-for-route-boundaries';
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const bearer = { Authorization: `Bearer ${operatorToken}` };
    assert.equal((await fetch(`${base}/api/session`, { headers: { ...bearer, Host: 'project.sites.localhost' } })).status, 404);
    assert.equal((await fetch(`${base}/api/session`, { headers: { ...bearer, Host: 'unknown.example' } })).status, 404);
    assert.equal((await fetch(`${base}/api/session`, { headers: { ...bearer, 'X-Forwarded-Host': 'project.sites.localhost' } })).status, 200);
    const unsupported = await fetch(`${base}/api/projects/00000000-0000-4000-8000-000000000001/webhook/github`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': '00000000-0000-4000-8000-000000000002', 'X-Hub-Signature-256': `sha256=${'0'.repeat(64)}` }, body: '{}' });
    assert.equal(unsupported.status, 415);
  } finally {
    restoreAuth();
    config.webhookKey = key;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
