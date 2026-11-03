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
  dashboardOrigin: process.env.DASHBOARD_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`,
};
