import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import express from 'express';
import { config } from '../src/config.js';
import { requireAuth, sessionRouter, signSession, verifySession } from '../src/auth.js';

const token = 'auth-test-only-'.padEnd(48, 'x');
const identity = { id: '00000000-0000-4000-8000-000000000001', name: 'Test operator' };

function configure(t: TestContext) {
  const original = { users: config.authUsers, secret: config.sessionSecret, origin: config.dashboardOrigin };
  config.authUsers = [{ ...identity, tokenHash: createHash('sha256').update(token).digest() }];
  config.sessionSecret = 'non-production-auth-test-secret-'.padEnd(48, 'x');
  config.dashboardOrigin = 'http://localhost:3000';
  t.after(() => { config.authUsers = original.users; config.sessionSecret = original.secret; config.dashboardOrigin = original.origin; });
}

test('sessions reject tampering, expiry, future lifetime and revoked identities', t => {
  configure(t);
  const now = Date.now();
  const signed = signSession(identity.id, now);
  assert.deepEqual(verifySession(signed, now), identity);
  assert.equal(verifySession(`${signed.slice(0, -1)}!`, now), null);
  const [payload, signature] = signed.split('.');
  const changedPayload = Buffer.from(JSON.stringify({ userId: 'different-user', expiresAt: now + 8 * 60 * 60 * 1000 })).toString('base64url');
  assert.equal(verifySession(`${changedPayload}.${signature}`, now), null);
  assert.equal(verifySession(`${payload}.${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`, now), null);
  assert.equal(verifySession(signed, now + 8 * 60 * 60 * 1000), null);
  assert.equal(verifySession(signSession(identity.id, now + 1000), now), null);
  assert.equal(verifySession('malformed'), null);
  const secret = config.sessionSecret;
  config.sessionSecret += '-rotated';
  assert.equal(verifySession(signed, now), null);
  config.sessionSecret = secret;
  const previousKeyHash = config.authUsers[0].tokenHash;
  config.authUsers[0].tokenHash = createHash('sha256').update('rotated-auth-test-key'.padEnd(48, 'x')).digest();
  assert.equal(verifySession(signed, now), null);
  assert.deepEqual(verifySession(signSession(identity.id, now), now), identity);
  config.authUsers[0].tokenHash = previousKeyHash;
  config.authUsers = [];
  assert.equal(verifySession(signed, now), null);
});

test('session HTTP endpoints and bearer authentication keep operator keys out of responses', async t => {
  configure(t);
  const app = express();
  app.use(express.json());
  app.use(sessionRouter);
  app.get('/private', requireAuth, (_req, res) => res.json({ user: res.locals.user }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/api/session`)).status, 401);
    assert.equal((await fetch(`${base}/private`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    const invalid = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'bad' }) });
    assert.equal(invalid.status, 401);
    assert.equal(invalid.headers.get('set-cookie'), null);
    const login = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), { user: identity });
    const cookie = login.headers.get('set-cookie')!;
    assert.match(cookie, /^shipyard_session=/);
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(cookie.includes(attribute));
    assert.ok(!cookie.includes('Domain=') && !cookie.includes(token));
    const headers = { cookie: cookie.split(';')[0] };
    const session = await fetch(`${base}/api/session`, { headers });
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { user: identity });
    assert.equal((await fetch(`${base}/private`, { headers: { cookie: 'shipyard_session=invalid', authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(`${base}/private`, { headers: { cookie: `${headers.cookie}; ${headers.cookie}` } })).status, 401);
    for (const authorization of ['Basic invalid', 'Bearer invalid', '']) {
      assert.equal((await fetch(`${base}/private`, { headers: { ...headers, authorization } })).status, 401);
    }
    const logout = await fetch(`${base}/api/session`, { method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie')!, /^shipyard_session=;/);
    assert.ok(logout.headers.get('set-cookie')!.includes('Expires=Thu, 01 Jan 1970'));
    config.dashboardOrigin = 'https://shipyard.example';
    const secureLogin = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const secureCookie = secureLogin.headers.get('set-cookie')!;
    assert.match(secureCookie, /^__Host-shipyard_session=/);
    assert.ok(secureCookie.includes('Secure') && !secureCookie.includes('Domain='));
    config.dashboardOrigin = 'http://localhost:3000';
    config.authUsers[0].tokenHash = createHash('sha256').update('rotated-auth-test-key'.padEnd(48, 'x')).digest();
    assert.equal((await fetch(`${base}/private`, { headers })).status, 401);
    config.authUsers = [];
    assert.equal((await fetch(`${base}/private`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
