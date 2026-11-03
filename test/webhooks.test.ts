import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express, { type ErrorRequestHandler } from 'express';
import { config } from '../src/config.js';
import { deriveWebhookSecret, verifyWebhookSignature, webhookRouter } from '../src/webhooks.js';

test('verifies GitHub SHA-256 signatures over the exact raw bytes', () => {
  // Official GitHub validation vector also checks compatibility without relying on our signer.
  const secret = "It's a Secret to Everybody";
  const payload = Buffer.from('Hello, World!');
  const signature = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.equal(verifyWebhookSignature(payload, signature, secret), true);
  assert.equal(verifyWebhookSignature(Buffer.from('Hello, World!\n'), signature, secret), false);
  assert.equal(verifyWebhookSignature(payload, signature, 'wrong secret'), false);
  for (const invalid of [undefined, null, [], '', 'sha1=' + 'a'.repeat(40), 'sha256=' + 'a'.repeat(63), signature.toUpperCase(), signature + ',other']) {
    assert.equal(verifyWebhookSignature(payload, invalid, secret), false);
  }
  const unicode = Buffer.from('{"message":"नमस्ते 🌊"}');
  const signed = `sha256=${createHmac('sha256', secret).update(unicode).digest('hex')}`;
  assert.equal(verifyWebhookSignature(unicode, signed, secret), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{ "message":"नमस्ते 🌊"}'), signed, secret), false);
});

test('derives a different secret for each project, version and master key', () => {
  const original = config.webhookKey;
  try {
    config.webhookKey = 'unit-test-webhook-master-key-at-least-32-characters';
    const id = randomUUID();
    const first = deriveWebhookSecret(id, 1);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(deriveWebhookSecret(id.toUpperCase(), 1), first);
    assert.notEqual(deriveWebhookSecret(id, 2), first);
    assert.notEqual(deriveWebhookSecret(randomUUID(), 1), first);
    config.webhookKey = 'another-unit-test-webhook-master-key-32-characters';
    assert.notEqual(deriveWebhookSecret(id, 1), first);
    assert.throws(() => deriveWebhookSecret('invalid', 1));
    for (const version of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => deriveWebhookSecret(id, version));
    config.webhookKey = '';
    assert.throws(() => deriveWebhookSecret(id, 1), /not configured/);
  } finally { config.webhookKey = original; }
});

test('webhook ingress rejects disabled, malformed and oversized requests before persistence', async () => {
  const original = config.webhookKey;
  const app = express();
  app.use(webhookRouter);
  app.use(express.json());
  app.post('/unrelated', (req, res) => { res.json(req.body); });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => { res.status(error.status ?? 500).json({ error: 'Request rejected' }); };
  app.use(errors);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const endpoint = `${base}/api/projects/${randomUUID()}/webhook/github`;
  const headers = { 'content-type': 'application/json', 'x-github-delivery': randomUUID(), 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) };
  try {
    config.webhookKey = '';
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: '{}' })).status, 503);
    config.webhookKey = 'unit-test-webhook-master-key-at-least-32-characters';
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'x-hub-signature-256': 'invalid' }, body: '{' })).status, 401);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'x-github-delivery': 'invalid' }, body: '{}' })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'x-github-event': 'bad event' }, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}/api/projects/invalid/webhook/github`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal((await fetch(endpoint, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'content-encoding': 'gzip' }, body: '{}' })).status, 415);
    const unrelated = await fetch(`${base}/unrelated`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"untouched":true}' });
    assert.deepEqual(await unrelated.json(), { untouched: true });
  } finally {
    config.webhookKey = original;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
