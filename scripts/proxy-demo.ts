import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { resolve, sep } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import type { Project } from '../src/contracts.js';
import { pool } from '../src/db.js';
import { parseArtifactManifest, s3 } from '../src/storage.js';

const image = 'nginx:1.30.6-alpine';
const dashboard = 'shipyard.example.com';
const dashboardOrigin = `https://${dashboard}:8443`;
const siteOrigin = 'https://sites.example.net:8443';

async function main() {
  const token: unknown = process.env.SHIPYARD_TOKEN || JSON.parse(process.env.AUTH_USERS || '[]')[0]?.token;
  assert.ok(typeof token === 'string', 'Provide an operator key or load generated AUTH_USERS from .env');
  const deadline = Date.now() + 5 * 60_000;
  const signal = AbortSignal.timeout(5 * 60_000);
  function command(file: string, args: string[], env = process.env, cleanup = false) {
    const remaining = cleanup ? 60_000 : deadline - Date.now();
    assert.ok(remaining > 0, 'HTTPS proxy demo deadline exceeded');
    return execFileSync(file, args, { env, encoding: 'utf8', timeout: Math.min(60_000, remaining), maxBuffer: 1024 * 1024 }).trim();
  }
  const temporaryRoot = resolve('.tmp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(resolve(temporaryRoot, 'proxy-'));
  const leafDirectory = resolve(directory, 'tls');
  await mkdir(leafDirectory);
  const container = `shipyard-proxy-${randomUUID()}`;
  let owned = false;
  let originalOrigins: { dashboard: string; sites: string } | undefined;
  let apiChanged = false;
  try {
    const smoke = JSON.parse(await readFile('.tmp/public-demo.json', 'utf8')) as { deployment: { id: string; projectId: string } };
    const stored = await pool.query<{ artifact_manifest: unknown }>('SELECT artifact_manifest FROM deployments WHERE id=$1 AND project_id=$2', [smoke.deployment.id, smoke.deployment.projectId]);
    const manifest = parseArtifactManifest(stored.rows[0]?.artifact_manifest, smoke.deployment.id);
    originalOrigins = JSON.parse(command('docker', ['compose', 'exec', '-T', 'api', 'node', '-p', 'JSON.stringify({dashboard:process.env.DASHBOARD_ORIGIN,sites:process.env.SITE_BASE_URL})']));
    assert.ok(originalOrigins && typeof originalOrigins.dashboard === 'string' && typeof originalOrigins.sites === 'string');
    const caKey = resolve(directory, 'ca.key');
    const caFile = resolve(directory, 'ca.pem');
    const key = resolve(leafDirectory, 'dashboard.key');
    const certificate = resolve(leafDirectory, 'dashboard.fullchain.pem');
    command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', caKey, '-out', caFile,
      '-subj', '/CN=Shipyard proxy CI CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
    command('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', resolve(directory, 'server.csr'), '-subj', `/CN=${dashboard}`]);
    await writeFile(resolve(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:shipyard.example.com,DNS:*.sites.example.net\n');
    command('openssl', ['x509', '-req', '-in', resolve(directory, 'server.csr'), '-CA', caFile, '-CAkey', caKey, '-CAcreateserial',
      '-out', certificate, '-days', '1', '-sha256', '-extfile', resolve(directory, 'server.ext')]);
    await writeFile(resolve(leafDirectory, 'sites.fullchain.pem'), await readFile(certificate));
    await writeFile(resolve(leafDirectory, 'sites.key'), await readFile(key), { mode: 0o600 });
    const ca = await readFile(caFile);
    const sample = await readFile('deploy/nginx.conf.example', 'utf8');
    assert.equal(sample.split('server 127.0.0.1:3000;').length, 2, 'Review changed proxy example before updating its fixture');
    const nginxConfig = sample.replace('server 127.0.0.1:3000;', 'server api:3000;');
    await writeFile(resolve(directory, 'default.conf'), nginxConfig);
    command('docker', ['pull', image]);
    const mounts = ['--mount', `type=bind,source=${leafDirectory},target=/etc/shipyard/tls,readonly`,
      '--mount', `type=bind,source=${resolve(directory, 'default.conf')},target=/etc/nginx/conf.d/default.conf,readonly`];
    command('docker', ['run', '--rm', '--network', 'shipyard_default', ...mounts, image, 'nginx', '-t']);
    const httpsEnv = { ...process.env, DASHBOARD_ORIGIN: dashboardOrigin, SITE_BASE_URL: siteOrigin };
    apiChanged = true;
    command('docker', ['compose', 'up', '-d', '--wait', '--no-deps', '--force-recreate', 'api'], httpsEnv);
    owned = true;
    command('docker', ['create', '--name', container, '--network', 'shipyard_default', '-p', '127.0.0.1:8443:443', ...mounts, image]);
    command('docker', ['start', container]);

    interface Result { status: number; headers: IncomingHttpHeaders; body: Buffer; protocol: string | null }
    function https(host: string, path: string, options: { method?: string; body?: unknown; headers?: Record<string, string>; trust?: boolean; servername?: string } = {}): Promise<Result> {
      return new Promise((resolveResponse, reject) => {
        signal.throwIfAborted();
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const outgoing = request({ hostname: '127.0.0.1', port: 8443, servername: options.servername ?? host,
          ca: options.trust === false ? undefined : ca, agent: false, path, method: options.method ?? 'GET',
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          headers: { Host: `${host}:8443`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
        }, incoming => {
          const chunks: Buffer[] = [];
          const socket = incoming.socket as TLSSocket;
          incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
          incoming.on('error', reject);
          incoming.on('end', () => {
            if (!socket.authorized) { reject(new Error('TLS connection must validate against the explicit test CA')); return; }
            resolveResponse({ status: incoming.statusCode ?? 500, headers: incoming.headers, body: Buffer.concat(chunks), protocol: socket.getProtocol() });
          });
        });
        outgoing.on('error', reject);
        outgoing.end(body);
      });
    }
    let health: Result | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { health = await https(dashboard, '/health'); if (health.status === 200) break; }
      catch (error) { if (attempt === 19) throw error; }
      await delay(500, undefined, { signal });
    }
    assert.equal(health?.status, 200, 'Platform must be healthy through Nginx TLS');
    await assert.rejects(https(dashboard, '/health', { trust: false }), error =>
      ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN'].includes((error as NodeJS.ErrnoException).code ?? ''));
    await assert.rejects(https(dashboard, '/health', { servername: 'wrong.example.org' }), error => (error as NodeJS.ErrnoException).code === 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal((await https(dashboard, '/api/session')).status, 401);
    const login = await https(dashboard, '/api/session', { method: 'POST', body: { token }, headers: { Origin: dashboardOrigin } });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie']?.[0];
    assert.ok(typeof cookie === 'string' && cookie.startsWith('__Host-shipyard_session='), 'HTTPS login must use the __Host cookie');
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag), `Session cookie needs ${flag}`);
    assert.ok(!/;\s*Domain=/i.test(cookie), 'Session cookie must be host-only');
    const headers = { Cookie: cookie.split(';')[0] };
    assert.equal((await https(dashboard, '/api/session', { headers })).status, 200);
    const projects = await https(dashboard, '/api/projects', { headers });
    assert.equal(projects.status, 200);
    const project = (JSON.parse(projects.body.toString('utf8')) as { projects: Project[] }).projects.find(item => item.id === smoke.deployment.projectId);
    assert.ok(project && project.activeDeploymentId === smoke.deployment.id);
    const siteHost = `${project.slug}.sites.example.net`;
    assert.equal(project.siteUrl, `https://${siteHost}:8443/`);
    assert.equal((await https(dashboard, '/api/session', { method: 'POST', body: { token }, headers: { Origin: `https://${siteHost}:8443` } })).status, 403);
    for (const path of ['/api/session', '/api/projects', '/health']) assert.equal((await https(siteHost, path, { headers })).status, 404);
    for (const route of [
      { host: siteHost, root: '/', version: `/_shipyard/v/${smoke.deployment.id}/`, sandbox: false },
      { host: dashboard, root: `/sites/${project.slug}/`, version: `/versions/${project.slug}/${smoke.deployment.id}/`, sandbox: true },
    ]) {
      const redirect = await https(route.host, route.root);
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.location, route.version);
      for (const file of manifest.files) {
        const response = await https(route.host, `${route.version}${file.key.split('/').map(encodeURIComponent).join('/')}`);
        assert.equal(response.status, 200, file.key);
        assert.equal(response.body.length, file.size, file.key);
        assert.equal(createHash('sha256').update(response.body).digest('hex'), file.sha256, file.key);
        if (file.key === 'index.html') {
          const csp = response.headers['content-security-policy'] ?? '';
          assert.ok(typeof csp === 'string' && csp.includes("object-src 'none'"));
          assert.equal(csp.includes('sandbox'), route.sandbox);
        }
      }
    }
    await assert.rejects(https('unknown.example.org', '/', { servername: dashboard }), error => (error as NodeJS.ErrnoException).code === 'ECONNRESET');
    const logout = await https(dashboard, '/api/session', { method: 'DELETE', body: {}, headers: { ...headers, Origin: dashboardOrigin } });
    assert.equal(logout.status, 204);
    assert.ok(logout.headers['set-cookie']?.some(value => value.startsWith('__Host-shipyard_session=;') && value.includes('Secure')), 'Logout must clear the same secure cookie');
    assert.equal((await https(dashboard, '/api/session')).status, 401);
    const evidence = {
      kind: 'loopback HTTPS/Nginx functional smoke with an explicit private test CA; no production certificate or DNS claim',
      recordedAt: new Date().toISOString(), platformSha: command('git', ['rev-parse', 'HEAD']),
      proxy: { image, digest: JSON.parse(command('docker', ['image', 'inspect', image, '--format', '{{json .RepoDigests}}']))[0],
        source: 'deploy/nginx.conf.example', modification: 'Upstream host only: 127.0.0.1 to Compose api',
        configSha256: createHash('sha256').update(nginxConfig).digest('hex'), loopbackPort: 8443, tlsProtocol: health.protocol,
        testCaFingerprint256: new X509Certificate(ca).fingerprint256 },
      deployment: { id: smoke.deployment.id, projectId: project.id, files: manifest.files.length, bytes: manifest.totalBytes, commitSha: manifest.commitSha },
      checks: ['nginx -t', 'trusted certificate and SNI', 'untrusted CA rejection', 'wrong SAN rejection', 'HTTPS health',
        'Secure HttpOnly SameSite=Strict host-only __Host session', 'cookie-authenticated management', 'cross-origin mutation rejection',
        'site-host API isolation', 'both HTTPS pinned routes: all file sizes/SHA-256 and CSP', 'unknown Host dropped', 'secure logout cookie clearing'],
      unchecked: ['browser cookie enforcement and site JavaScript execution', 'public DNS/ingress', 'public CA issuance/renewal', 'production deployment', 'TLS capacity'],
    };
    await writeFile('.tmp/proxy-demo.json', `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    try {
      if (owned) {
        try { command('docker', ['rm', '-f', container], process.env, true); }
        catch (error) { if (!String((error as { stderr?: unknown }).stderr).includes(`No such container: ${container}`)) throw error; }
      }
    } finally {
      try {
        if (apiChanged && originalOrigins) command('docker', ['compose', 'up', '-d', '--wait', '--no-deps', '--force-recreate', 'api'],
          { ...process.env, DASHBOARD_ORIGIN: originalOrigins.dashboard, SITE_BASE_URL: originalOrigins.sites }, true);
      } finally {
        assert.ok(resolve(directory).startsWith(temporaryRoot + sep));
        await rm(directory, { recursive: true, force: true });
        await pool.end();
        s3.destroy();
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
