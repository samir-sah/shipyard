import { createHash } from 'node:crypto';

export interface AuthUser { id: string; name: string; tokenHash: Buffer }

function authUsers(): AuthUser[] {
  let entries: unknown;
  try { entries = JSON.parse(process.env.AUTH_USERS || '[]'); }
  catch { throw new Error('AUTH_USERS must be a JSON array'); }
  if (!Array.isArray(entries)) throw new Error('AUTH_USERS must be a JSON array');
  const ids = new Set<string>();
  const tokens = new Set<string>();
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(entry.id) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80 || typeof entry.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(entry.token)) throw new Error('AUTH_USERS entries need a UUID, name and a 32–128 character access token');
    const tokenHash = createHash('sha256').update(entry.token).digest();
    const id = entry.id.toLowerCase();
    if (ids.has(id) || tokens.has(tokenHash.toString('hex'))) throw new Error('AUTH_USERS IDs and tokens must be unique');
    ids.add(id);
    tokens.add(tokenHash.toString('hex'));
    return { id, name: entry.name.trim(), tokenHash };
  });
}

function origin(name: string, fallback: string): string {
  const value = new URL(process.env[name] || fallback);
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.pathname !== '/' || value.search || value.hash) throw new Error(`${name} must be an HTTP(S) origin`);
  return value.origin;
}

function positiveNumber(name: string, fallback: number, integer = true): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://shipyard:shipyard-local@127.0.0.1:5432/shipyard',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  s3Endpoint: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:8333',
  s3Region: process.env.S3_REGION ?? 'us-east-1',
  s3Bucket: process.env.S3_BUCKET ?? 'shipyard-artifacts',
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? 'shipyard-local',
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? 'shipyard-local-secret',
  host: process.env.HOST ?? '127.0.0.1',
  port: positiveNumber('PORT', 3000),
  buildImage: process.env.BUILD_IMAGE ?? 'shipyard-builder:local',
  buildTimeoutMs: positiveNumber('BUILD_TIMEOUT_MS', 300_000),
  buildCpus: positiveNumber('BUILD_CPUS', 1, false),
  buildMemoryMb: positiveNumber('BUILD_MEMORY_MB', 512),
  buildPids: positiveNumber('BUILD_PIDS', 128),
  workerConcurrency: positiveNumber('WORKER_CONCURRENCY', 1),
  workerLeaseMs: positiveNumber('WORKER_LEASE_MS', 30_000),
  maxBuildAttempts: positiveNumber('MAX_BUILD_ATTEMPTS', 3),
  maxArtifactBytes: positiveNumber('MAX_ARTIFACT_BYTES', 64 * 1024 * 1024),
  maxArtifactFiles: positiveNumber('MAX_ARTIFACT_FILES', 5_000),
  maxLogBytes: positiveNumber('MAX_LOG_BYTES', 1024 * 1024),
  dashboardOrigin: origin('DASHBOARD_ORIGIN', `http://localhost:${process.env.PORT ?? 3000}`),
  siteBaseUrl: origin('SITE_BASE_URL', `http://sites.localhost:${process.env.PORT ?? 3000}`),
  authUsers: authUsers(),
  sessionSecret: process.env.SESSION_SECRET ?? '',
  webhookKey: process.env.GITHUB_WEBHOOK_KEY ?? '',
  retentionDays: Number(process.env.RETENTION_DAYS ?? 0),
  retentionKeep: positiveNumber('RETENTION_KEEP', 5),
};

if (!Number.isSafeInteger(config.retentionDays) || config.retentionDays < 0) throw new Error('RETENTION_DAYS must be a nonnegative integer');
const siteHost = new URL(config.siteBaseUrl).hostname;
const dashboardHost = new URL(config.dashboardOrigin).hostname;
if (siteHost === dashboardHost || dashboardHost.endsWith(`.${siteHost}`)) throw new Error('SITE_BASE_URL must use a host separate from the dashboard');

export function validateApiSecurityConfig(): void {
  if (!config.authUsers.length || Buffer.byteLength(config.sessionSecret) < 32) throw new Error('Configure AUTH_USERS and SESSION_SECRET first: run npm run setup');
  if (config.webhookKey && Buffer.byteLength(config.webhookKey) < 32) throw new Error('GITHUB_WEBHOOK_KEY must contain at least 32 bytes');
}
