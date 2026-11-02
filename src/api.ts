import express, { type ErrorRequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { lookup } from 'mime-types';
import { config } from './config.js';
import { pool, migrate, projectColumns, deploymentColumns } from './db.js';
import { s3, ensureBucket, getArtifact } from './storage.js';
import { artifactKey, InputError, logCursor, parseProject, requireUuid } from './validation.js';

async function enqueue(id: string): Promise<void> {
  try { await (await import('./queue.js')).enqueueDeployment(id); }
  catch (error) { console.error('Deployment remains queued; worker dispatcher will retry', error); }
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
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

  app.get('/health', async (_req, res) => {
    try {
      const { queue } = await import('./queue.js');
      await Promise.all([pool.query('SELECT 1'), queue.getJobCounts('waiting'), s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket }))]);
      res.json({ status: 'ok' });
    } catch { res.status(503).json({ status: 'unavailable' }); }
  });

  app.get('/api/projects', async (_req, res) => {
    const result = await pool.query(`SELECT ${projectColumns} FROM projects ORDER BY created_at DESC LIMIT 200`);
    res.json({ projects: result.rows });
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
      project = (await client.query(`INSERT INTO projects(id, name, slug, repo_url) VALUES ($1, $2, $3, $4) RETURNING ${projectColumns}`, [id, input.name, slug, input.repoUrl])).rows[0];
      deployment = (await client.query(`INSERT INTO deployments(id, project_id) VALUES ($1, $2) RETURNING ${deploymentColumns}`, [deploymentId, id])).rows[0];
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    await enqueue(deploymentId);
    res.status(201).json({ project, deployment });
  });

  app.post('/api/projects/:id/deployments', async (req, res) => {
    const projectId = requireUuid(req.params.id);
    const id = randomUUID();
    const result = await pool.query(`INSERT INTO deployments(id, project_id) SELECT $1, id FROM projects WHERE id = $2 RETURNING ${deploymentColumns}`, [id, projectId]);
    if (!result.rowCount) { res.status(404).json({ error: 'Project not found' }); return; }
    await enqueue(id);
    res.status(201).json({ deployment: result.rows[0] });
  });

  app.get('/api/projects/:id/deployments', async (req, res) => {
    const id = requireUuid(req.params.id);
    const project = await pool.query('SELECT 1 FROM projects WHERE id = $1', [id]);
    if (!project.rowCount) { res.status(404).json({ error: 'Project not found' }); return; }
    const result = await pool.query(`SELECT ${deploymentColumns} FROM deployments WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, [id]);
    res.json({ deployments: result.rows });
  });

  app.get('/api/deployments/:id/logs', async (req, res) => {
    const id = requireUuid(req.params.id);
    const after = logCursor(req.query.after);
    const exists = await pool.query('SELECT 1 FROM deployments WHERE id = $1', [id]);
    if (!exists.rowCount) { res.status(404).json({ error: 'Deployment not found' }); return; }
    const result = await pool.query('SELECT id::float8 AS id, stream, message, created_at AS "createdAt" FROM deployment_logs WHERE deployment_id = $1 AND id > $2 ORDER BY id LIMIT 200', [id, after]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ logs: result.rows, nextCursor: result.rows.at(-1)?.id ?? after });
  });

  app.get('/sites/:slug', (req, res) => { res.redirect(308, `/sites/${encodeURIComponent(req.params.slug)}/`); });
  app.get('/sites/:slug/{*path}', async (req, res) => {
    const result = await pool.query<{ active_deployment_id: string | null }>('SELECT active_deployment_id FROM projects WHERE slug = $1', [req.params.slug]);
    const deploymentId = result.rows[0]?.active_deployment_id;
    if (!deploymentId) { res.status(404).send('No active deployment'); return; }
    const parts = req.params.path as unknown as string[] | undefined;
    let key = artifactKey(parts?.join('/') || 'index.html');
    let artifact;
    try { artifact = await getArtifact(deploymentId, key); }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
      if (extname(key)) { res.status(404).send('Artifact not found'); return; }
      key = 'index.html';
      artifact = await getArtifact(deploymentId, key);
    }
    // Path-hosted sites need an opaque origin so their scripts cannot access the dashboard or its API.
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-downloads; object-src \'none\'');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    res.type(lookup(key) || 'application/octet-stream');
    if (artifact.ContentLength !== undefined) res.setHeader('Content-Length', artifact.ContentLength);
    if (!artifact.Body) { res.status(502).send('Artifact body is missing'); return; }
    await pipeline(artifact.Body as Readable, res);
  });

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found' }); });
  const dashboard = resolve('dist/dashboard');
  app.use(express.static(dashboard, { index: 'index.html' }));
  app.get('/', (_req, res, next) => { res.sendFile(resolve(dashboard, 'index.html'), error => { if (error) next(error); }); });
  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof InputError) { res.status(400).json({ error: error.message }); return; }
    if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'Invalid JSON' }); return; }
    if ((error as { status?: number }).status === 413) { res.status(413).json({ error: 'Request body is too large' }); return; }
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  };
  app.use(onError);
  return app;
}

async function main(): Promise<void> {
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
