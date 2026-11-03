import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { lookup } from 'mime-types';
import { config, validateApiSecurityConfig } from './config.js';
import { pool, migrate, projectColumns, deploymentColumns, createDeployment, rollbackDeployment, configureWebhook, setDeploymentRetained } from './db.js';
import { s3, ensureBucket, getArtifact, validateStoredVersion } from './storage.js';
import { artifactKey, InputError, logCursor, parseProject, requireUuid } from './validation.js';
import type { ArtifactManifest, Project } from './contracts.js';
import { requireAuth, sessionRouter } from './auth.js';
import { webhookRouter, deriveWebhookSecret } from './webhooks.js';
import { routeHost, siteUrl } from './routing.js';

function presentProject(project: Project): Project {
  return { ...project, siteUrl: siteUrl(project.slug) };
}

async function enqueue(id: string): Promise<void> {
  try { await (await import('./queue.js')).enqueueDeployment(id); }
  catch (error) { console.error('Deployment remains queued; worker dispatcher will retry', error); }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(routeHost);
  app.use(webhookRouter);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const allowedOrigins = new Set([config.dashboardOrigin, `http://127.0.0.1:${config.port}`, 'http://localhost:5173', 'http://127.0.0.1:5173']);
      if ((req.headers.origin && !allowedOrigins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
        res.status(403).json({ error: 'Cross-origin mutations are not allowed' });
        return;
      }
      if (!req.is('application/json')) { res.status(415).json({ error: 'Use application/json' }); return; }
    }
    next();
  });
  app.use(express.json({ limit: '4kb', strict: true }));
  app.use(sessionRouter);
  app.use('/api', requireAuth);

  app.get('/health', async (_req, res) => {
    try {
      const { queue } = await import('./queue.js');
      await Promise.all([pool.query('SELECT 1'), queue.getJobCounts('waiting'), s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket }))]);
      res.json({ status: 'ok' });
    } catch { res.status(503).json({ status: 'unavailable' }); }
  });

  app.get('/api/projects', async (_req, res) => {
    const result = await pool.query<Project>(`SELECT ${projectColumns} FROM projects WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 200`, [res.locals.user.id]);
    res.json({ projects: result.rows.map(presentProject) });
  });

  app.post('/api/projects', async (req, res) => {
    const input = parseProject(req.body);
    const id = randomUUID();
    const deploymentId = randomUUID();
    const slug = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site'}-${id.slice(0, 8)}`;
    const client = await pool.connect();
    let project;
    let deployment;
    try {
      await client.query('BEGIN');
      project = (await client.query<Project>(`INSERT INTO projects(id, name, slug, repo_url, publish_generation, owner_id) VALUES ($1, $2, $3, $4, 1, $5) RETURNING ${projectColumns}`, [id, input.name, slug, input.repoUrl, res.locals.user.id])).rows[0];
      deployment = (await client.query(`INSERT INTO deployments(id, project_id, publish_generation) VALUES ($1, $2, 1) RETURNING ${deploymentColumns}`, [deploymentId, id])).rows[0];
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await enqueue(deploymentId);
    res.status(201).json({ project: presentProject(project), deployment });
  });

  app.post('/api/projects/:id/deployments', async (req, res) => {
    const projectId = requireUuid(req.params.id);
    if (!(await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2', [projectId, res.locals.user.id])).rowCount) { res.status(404).json({ error: 'Project not found' }); return; }
    const deployment = await createDeployment(projectId);
    if (!deployment) { res.status(404).json({ error: 'Project not found' }); return; }
    await enqueue(deployment.id);
    res.status(201).json({ deployment });
  });

  app.post('/api/projects/:id/rollback', async (req, res) => {
    const projectId = requireUuid(req.params.id);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || typeof req.body.deploymentId !== 'string') {
      throw new InputError('Expected a deploymentId');
    }
    const deploymentId = requireUuid(req.body.deploymentId);
    const owned = await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2', [projectId, res.locals.user.id]);
    if (!owned.rowCount) { res.status(404).json({ error: 'Project not found' }); return; }
    const target = await pool.query<{ artifact_manifest: ArtifactManifest | null }>("SELECT artifact_manifest FROM deployments WHERE id = $1 AND project_id = $2 AND status = 'deployed' AND artifact_state='available'", [deploymentId, projectId]);
    if (!target.rowCount) { res.status(404).json({ error: 'Completed deployment not found for this project' }); return; }
    let manifest;
    try { manifest = await validateStoredVersion(deploymentId, { allowLegacy: target.rows[0].artifact_manifest === null, expectedManifest: target.rows[0].artifact_manifest ?? undefined }); }
    catch { res.status(409).json({ error: 'Stored version is incomplete or unavailable' }); return; }
    const project = await rollbackDeployment(projectId, deploymentId, manifest);
    if (!project) { res.status(404).json({ error: 'Completed deployment not found for this project' }); return; }
    res.json({ project: presentProject(project) });
  });

  app.post('/api/projects/:id/webhook', async (req, res) => {
    const id = requireUuid(req.params.id);
    if (!req.body || typeof req.body.enabled !== 'boolean') throw new InputError('Expected enabled to be true or false');
    if (req.body.enabled && Buffer.byteLength(config.webhookKey) < 32) { res.status(503).json({ error: 'Webhook signing key is not configured' }); return; }
    const result = await configureWebhook(id, res.locals.user.id, req.body.enabled);
    if (!result) { res.status(404).json({ error: 'Project not found' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.json({ project: presentProject(result.project), webhookUrl: `${config.dashboardOrigin}/api/projects/${id}/webhook/github`, ...(req.body.enabled ? { secret: deriveWebhookSecret(id, result.keyVersion) } : {}) });
  });

  app.post('/api/projects/:id/deployments/:deploymentId/retain', async (req, res) => {
    const id = requireUuid(req.params.id);
    const deploymentId = requireUuid(req.params.deploymentId);
    if (!req.body || typeof req.body.retained !== 'boolean') throw new InputError('Expected retained to be true or false');
    if (!(await pool.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2', [id, res.locals.user.id])).rowCount) { res.status(404).json({ error: 'Project not found' }); return; }
    const deployment = await setDeploymentRetained(id, deploymentId, req.body.retained);
    if (!deployment) { res.status(404).json({ error: 'Available deployment not found' }); return; }
    res.json({ deployment });
  });

  app.get('/api/projects/:id/deployments', async (req, res) => {
    const id = requireUuid(req.params.id);
    const project = await pool.query('SELECT 1 FROM projects WHERE id = $1 AND owner_id=$2', [id, res.locals.user.id]);
    if (!project.rowCount) { res.status(404).json({ error: 'Project not found' }); return; }
    const result = await pool.query(`SELECT ${deploymentColumns} FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]);
    res.json({ deployments: result.rows });
  });

  app.get('/api/deployments/:id/logs', async (req, res) => {
    const id = requireUuid(req.params.id);
    const after = logCursor(req.query.after);
    const exists = await pool.query('SELECT 1 FROM deployments d JOIN projects p ON p.id=d.project_id WHERE d.id=$1 AND p.owner_id=$2', [id, res.locals.user.id]);
    if (!exists.rowCount) { res.status(404).json({ error: 'Deployment not found' }); return; }
    const result = await pool.query('SELECT id::float8 AS id, stream, message, created_at AS "createdAt" FROM deployment_logs WHERE deployment_id = $1 AND id > $2 ORDER BY id LIMIT 200', [id, after]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ logs: result.rows, nextCursor: result.rows.at(-1)?.id ?? after });
  });

  app.get('/sites/:slug', (req, res, next) => {
    if (req.path.endsWith('/')) { next(); return; }
    res.redirect(308, `/sites/${encodeURIComponent(req.params.slug)}/`);
  });
  app.get('/sites/:slug/{*path}', async (req, res) => {
    const result = await pool.query<{ active_deployment_id: string | null }>('SELECT active_deployment_id FROM projects WHERE slug = $1', [req.params.slug]);
    const deploymentId = result.rows[0]?.active_deployment_id;
    if (!deploymentId) { res.status(404).send('No active deployment'); return; }
    const parts = req.params.path as unknown as string[] | undefined;
    if (parts) artifactKey(parts.join('/'));
    const suffix = parts?.map(encodeURIComponent).join('/') ?? '';
    res.setHeader('Cache-Control', 'no-store');
    const versionPath = res.locals.siteSlug ? `/_shipyard/v/${deploymentId}/` : `/versions/${encodeURIComponent(req.params.slug)}/${deploymentId}/`;
    res.redirect(302, `${versionPath}${suffix}${new URL(req.originalUrl, 'http://localhost').search}`);
  });
  app.get('/versions/:slug/:deploymentId', (req, res, next) => {
    if (req.path.endsWith('/')) { next(); return; }
    requireUuid(req.params.deploymentId);
    res.redirect(308, res.locals.siteSlug ? `/_shipyard/v/${req.params.deploymentId}/` : `/versions/${encodeURIComponent(req.params.slug)}/${req.params.deploymentId}/`);
  });
  app.get('/versions/:slug/:deploymentId/{*path}', async (req, res) => {
    const deploymentId = requireUuid(req.params.deploymentId);
    const version = await pool.query<{ artifact_manifest: ArtifactManifest | null; artifact_state: string }>(
      "SELECT d.artifact_manifest,d.artifact_state FROM deployments d JOIN projects p ON p.id = d.project_id WHERE p.slug = $1 AND d.id = $2 AND d.status = 'deployed'", [req.params.slug, deploymentId],
    );
    if (!version.rowCount) { res.status(404).send('Completed version not found'); return; }
    if (version.rows[0].artifact_state !== 'available') { res.status(410).send('Version artifacts have expired'); return; }
    const parts = req.params.path as unknown as string[] | undefined;
    let key = artifactKey(parts?.join('/') || 'index.html');
    const manifest = version.rows[0].artifact_manifest;
    if (key === '__shipyard_manifest.json') { res.status(404).send('Artifact not found'); return; }
    if (manifest && !manifest.files.some(file => file.key === key)) {
      if (extname(key)) { res.status(404).send('Artifact not found'); return; }
      key = 'index.html';
    }
    let artifact;
    try { artifact = await getArtifact(deploymentId, key, manifest?.attemptId); }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      if (extname(key)) { res.status(404).send('Artifact not found'); return; }
      key = 'index.html';
      artifact = await getArtifact(deploymentId, key, manifest?.attemptId);
    }
    // Path-hosted sites need an opaque origin so their scripts cannot access the dashboard or its API.
    res.setHeader('Content-Security-Policy', res.locals.siteSlug ? "object-src 'none'; base-uri 'self'" : 'sandbox allow-scripts allow-forms allow-popups allow-downloads; object-src \'none\'');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.type(lookup(key) || 'application/octet-stream');
    if (artifact.ContentLength !== undefined) res.setHeader('Content-Length', artifact.ContentLength);
    if (!artifact.Body) { res.status(502).send('Artifact body is missing'); return; }
    await pipeline(artifact.Body as Readable, res);
  });

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found' }); });
  const dashboard = resolve('dist/dashboard');
  app.use((_req, res, next) => { res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"); next(); });
  app.use(express.static(dashboard, { index: 'index.html' }));
  app.get('/', (_req, res, next) => { res.sendFile(resolve(dashboard, 'index.html'), error => { if (error) next(error); }); });
  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof InputError) { res.status(400).json({ error: error.message }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'Invalid JSON' }); return; }
    if ((error as { status?: number }).status === 413) { res.status(413).json({ error: 'Request body is too large' }); return; }
    if ((error as { status?: number }).status === 415) { res.status(415).json({ error: 'Unsupported request encoding' }); return; }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(onError);
  return app;
}

async function main(): Promise<void> {
  validateApiSecurityConfig();
  await migrate();
  await ensureBucket();
  const server = createApp().listen(config.port, config.host, () => console.log(`Shipyard API listening on ${config.host}:${config.port}`));
  async function shutdown() {
    server.close(async () => {
      await (await import('./queue.js')).queue.close();
      await pool.end();
      s3.destroy();
    });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
