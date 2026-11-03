import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { config } from './config.js';
import { acceptWebhook, pool } from './db.js';
import { InputError, requireUuid } from './validation.js';

const signaturePattern = /^sha256=[a-f0-9]{64}$/;

export function deriveWebhookSecret(projectId: string, keyVersion: number): string {
  requireUuid(projectId);
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error('Invalid webhook key version');
  if (Buffer.byteLength(config.webhookKey) < 32) throw new Error('GitHub webhooks are not configured');
  return createHmac('sha256', config.webhookKey).update(`${projectId.toLowerCase()}:${keyVersion}`).digest('hex');
}

export function verifyWebhookSignature(payload: Uint8Array, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string' || !signaturePattern.test(signature) || !secret) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

export const webhookRouter = Router();

webhookRouter.post('/api/projects/:id/webhook/github', (req, res, next) => {
  if (Buffer.byteLength(config.webhookKey) < 32) { res.status(503).json({ error: 'GitHub webhooks are not configured' }); return; }
  if (!req.is('application/json')) { res.status(415).json({ error: 'Use application/json' }); return; }
  if (!signaturePattern.test(req.get('x-hub-signature-256') ?? '')) { res.status(401).json({ error: 'Invalid webhook signature' }); return; }
  try {
    requireUuid(req.params.id);
    requireUuid(req.get('x-github-delivery') ?? '');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(req.get('x-github-event') ?? '')) throw new InputError('Invalid webhook event');
    next();
  } catch { res.status(400).json({ error: 'Invalid webhook headers or project ID' }); }
}, express.raw({ type: 'application/json', limit: '1mb', inflate: false }), async (req, res) => {
  const projectId = req.params.id.toLowerCase();
  const deliveryId = req.get('x-github-delivery')!.toLowerCase();
  const eventType = req.get('x-github-event')!;
  const result = await pool.query<{ repo_url: string; webhook_enabled: boolean; webhook_key_version: number }>('SELECT repo_url, webhook_enabled, webhook_key_version FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project?.webhook_enabled) { res.status(404).json({ error: 'Webhook not found' }); return; }
  if (!Buffer.isBuffer(req.body) || !verifyWebhookSignature(req.body, req.get('x-hub-signature-256'), deriveWebhookSecret(projectId, project.webhook_key_version))) {
    res.status(401).json({ error: 'Invalid webhook signature' }); return;
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(req.body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    payload = parsed as Record<string, unknown>;
  } catch { res.status(400).json({ error: 'Invalid webhook payload' }); return; }
  const repository = payload.repository as { full_name?: unknown } | null | undefined;
  const expectedRepository = new URL(project.repo_url).pathname.replace(/^\//, '').replace(/\.git\/?$/i, '').replace(/\/$/, '').toLowerCase();
  if (typeof repository?.full_name !== 'string' || repository.full_name.toLowerCase() !== expectedRepository) {
    res.status(400).json({ error: 'Webhook repository does not match this project' }); return;
  }
  let commitSha: string | null = null;
  if (eventType === 'push') {
    if (typeof payload.ref !== 'string' || !payload.ref || payload.ref.length > 1024 || typeof payload.deleted !== 'boolean') {
      res.status(400).json({ error: 'Invalid push payload' }); return;
    }
    if (payload.ref === 'refs/heads/main' && !payload.deleted) {
      if (typeof payload.after !== 'string' || !/^[a-f0-9]{40}$/.test(payload.after) || /^0+$/.test(payload.after)) {
        res.status(400).json({ error: 'Invalid push commit' }); return;
      }
      commitSha = payload.after;
    }
  }
  const accepted = await acceptWebhook(projectId, project.webhook_key_version, deliveryId, createHash('sha256').update(req.body).digest('hex'), eventType, commitSha);
  if (accepted === null) { res.status(404).json({ error: 'Webhook not found' }); return; }
  if (accepted === 'conflict') { res.status(409).json({ error: 'Webhook delivery conflicts with an earlier delivery' }); return; }
  if (accepted === 'disabled') { res.status(409).json({ error: 'Webhook configuration changed; redeliver with its current secret' }); return; }
  if (accepted.deploymentId) {
    try { await (await import('./queue.js')).enqueueDeployment(accepted.deploymentId); }
    catch { console.error('Webhook deployment remains queued; dispatcher will retry'); }
  }
  res.status(202).json({ accepted: true, duplicate: accepted.duplicate, deploymentId: accepted.deploymentId });
});
