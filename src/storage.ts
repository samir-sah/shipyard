import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { lookup } from 'mime-types';
import { config } from './config.js';
import { artifactKey, InputError, requireUuid } from './validation.js';
import type { ArtifactManifest } from './contracts.js';

const manifestKey = '__shipyard_manifest.json';

function versionPrefix(deploymentId: string, attemptId?: string): string {
  requireUuid(deploymentId);
  if (attemptId !== undefined) requireUuid(attemptId);
  return `deployments/${deploymentId}/${attemptId === undefined ? '' : `attempts/${attemptId}/`}`;
}

function outputKey(key: string): string {
  artifactKey(key);
  if (key === manifestKey) throw new InputError('Artifact uses a reserved manifest name');
  return key;
}

export function parseArtifactManifest(input: unknown, deploymentId: string): ArtifactManifest {
  requireUuid(deploymentId);
  if (!input || typeof input !== 'object') throw new Error('Invalid artifact manifest');
  const value = input as Partial<ArtifactManifest>;
  if (value.version !== 1 || value.deploymentId !== deploymentId || !Array.isArray(value.files) || !value.files.length || value.files.length > config.maxArtifactFiles) throw new Error('Invalid artifact manifest');
  if (value.attemptId !== undefined || value.commitSha !== undefined) {
    if (typeof value.attemptId !== 'string' || typeof value.commitSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.commitSha)) throw new Error('Invalid artifact attempt');
    requireUuid(value.attemptId);
  }
  const keys = new Set<string>();
  let totalBytes = 0;
  for (const file of value.files) {
    if (!file || typeof file.key !== 'string' || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid artifact file');
    outputKey(file.key);
    if (keys.has(file.key)) throw new Error('Duplicate artifact path');
    keys.add(file.key);
    totalBytes += file.size;
    if (totalBytes > config.maxArtifactBytes) throw new Error('Artifact size limit exceeded');
  }
  if (!keys.has('index.html') || value.totalBytes !== totalBytes) throw new Error('Incomplete artifact manifest');
  return value as ArtifactManifest;
}

export const s3 = new S3Client({
  endpoint: config.s3Endpoint,
  region: config.s3Region,
  forcePathStyle: true,
  credentials: { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey },
  requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
});

export async function ensureBucket(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      try { await s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket })); }
      catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) throw error;
        try { await s3.send(new CreateBucketCommand({ Bucket: config.s3Bucket })); }
        catch (createError) {
          if ((createError as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 409) throw createError;
          await s3.send(new HeadBucketCommand({ Bucket: config.s3Bucket }));
        }
      }
      return;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (attempt === 9 || (status !== undefined && status < 500)) throw error;
      await delay(1_000);
    }
  }
}

export interface ArtifactFile { key: string; path: string; size: number; sha256: string }

export async function inspectArtifacts(directory: string, limits = { maxBytes: config.maxArtifactBytes, maxFiles: config.maxArtifactFiles }): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  let totalBytes = 0;
  let directories = 0;
  async function walk(path: string, prefix: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error('Artifact directory depth limit exceeded');
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = outputKey(prefix + entry.name);
      const filePath = join(path, entry.name);
      const stat = await lstat(filePath);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`Unsupported artifact: ${key}`);
      if (stat.isDirectory()) {
        if (++directories > limits.maxFiles) throw new Error('Artifact directory count limit exceeded');
        await walk(filePath, `${key}/`, depth + 1);
      }
      else {
        totalBytes += stat.size;
        if (totalBytes > limits.maxBytes || files.length >= limits.maxFiles) throw new Error('Artifact size or file count limit exceeded');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(filePath)) hash.update(chunk);
        files.push({ key, path: filePath, size: stat.size, sha256: hash.digest('hex') });
      }
    }
  }
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Artifact output must be a directory');
  await walk(directory, '', 0);
  if (!files.some(file => file.key === 'index.html')) throw new Error('Build output must contain index.html');
  return files;
}

async function verifyStoredFile(prefix: string, file: ArtifactManifest['files'][number], signal?: AbortSignal): Promise<void> {
  const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: prefix + file.key }), { abortSignal: signal });
  if (!object.Body || object.ContentLength !== file.size) {
    (object.Body as { destroy?: () => void } | undefined)?.destroy?.();
    throw new Error(`Artifact validation failed: ${file.key}`);
  }
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > file.size) throw new Error(`Artifact size mismatch: ${file.key}`);
    hash.update(chunk);
  }
  if (size !== file.size || hash.digest('hex') !== file.sha256) throw new Error(`Artifact checksum mismatch: ${file.key}`);
}

async function readManifest(deploymentId: string, attemptId?: string, signal?: AbortSignal): Promise<ArtifactManifest | null> {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: versionPrefix(deploymentId, attemptId) + manifestKey }), { abortSignal: signal });
    if (!object.Body) throw new Error('Artifact manifest body is missing');
    // A 1,024-byte key can expand sixfold when JSON escapes control characters.
    const maxBytes = config.maxArtifactFiles * (6 * 1_024 + 256) + 1_024;
    let size = 0;
    const chunks: Uint8Array[] = [];
    for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('Artifact manifest size limit exceeded');
      chunks.push(chunk);
    }
    const manifest = parseArtifactManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')), deploymentId);
    if (manifest.attemptId !== attemptId) throw new Error('Artifact manifest does not match its attempt prefix');
    return manifest;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function writeManifest(manifest: ArtifactManifest, signal?: AbortSignal): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: versionPrefix(manifest.deploymentId, manifest.attemptId) + manifestKey, Body: JSON.stringify(manifest), ContentType: 'application/json', IfNoneMatch: '*' }), { abortSignal: signal });
}

export async function uploadArtifacts(deploymentId: string, directory: string, signal?: AbortSignal, attempt?: { token: string; commitSha: string }): Promise<ArtifactManifest> {
  if (attempt) requireUuid(attempt.token);
  const prefix = versionPrefix(deploymentId, attempt?.token);
  if (attempt && !/^[a-f0-9]{40}$/.test(attempt.commitSha)) throw new Error('Invalid artifact commit');
  signal?.throwIfAborted();
  const files = await inspectArtifacts(directory);
  const manifest = parseArtifactManifest({ version: 1, deploymentId, ...(attempt ? { attemptId: attempt.token, commitSha: attempt.commitSha } : {}), files: files.map(({ key, size, sha256 }) => ({ key, size, sha256 })).sort((a, b) => a.key.localeCompare(b.key)), totalBytes: files.reduce((sum, file) => sum + file.size, 0) }, deploymentId);
  for (const file of files) {
    signal?.throwIfAborted();
    const key = prefix + file.key;
    await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: createReadStream(file.path), ContentLength: file.size, ContentType: lookup(file.key) || 'application/octet-stream', Metadata: { sha256: file.sha256 }, IfNoneMatch: '*' }), { abortSignal: signal });
    await verifyStoredFile(prefix, file, signal);
  }
  await writeManifest(manifest, signal);
  return manifest;
}

export async function validateStoredVersion(deploymentId: string, options: { allowLegacy?: boolean; expectedManifest?: ArtifactManifest; attemptId?: string } = {}): Promise<ArtifactManifest> {
  const expected = options.expectedManifest ? parseArtifactManifest(options.expectedManifest, deploymentId) : undefined;
  if (options.attemptId !== undefined && expected?.attemptId !== undefined && expected.attemptId !== options.attemptId) throw new Error('Conflicting artifact attempt IDs');
  const attemptId = expected?.attemptId ?? options.attemptId;
  const prefix = versionPrefix(deploymentId, attemptId);
  const signal = AbortSignal.timeout(config.buildTimeoutMs);
  let manifest = await readManifest(deploymentId, attemptId, signal);
  if (expected) {
    const files = new Map(expected.files.map(file => [file.key, file]));
    if (!manifest || manifest.attemptId !== expected.attemptId || manifest.commitSha !== expected.commitSha || manifest.totalBytes !== expected.totalBytes || manifest.files.length !== expected.files.length || manifest.files.some(file => {
      const saved = files.get(file.key);
      return !saved || saved.size !== file.size || saved.sha256 !== file.sha256;
    })) throw new Error('Stored artifact manifest differs from the completed deployment');
  }
  if (!manifest) {
    if (!options.allowLegacy || attemptId !== undefined) throw new Error('Artifact version has no completion manifest');
    // Only persisted successful M1 deployments may discover a manifest from their existing prefix.
    const files: ArtifactManifest['files'] = [];
    let continuation: string | undefined;
    let totalBytes = 0;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: prefix, ContinuationToken: continuation }), { abortSignal: signal });
      for (const object of page.Contents ?? []) {
        const key = outputKey(object.Key?.slice(prefix.length) ?? '');
        if (files.length >= config.maxArtifactFiles || !Number.isSafeInteger(object.Size) || object.Size! < 0) throw new Error('Invalid legacy artifact');
        totalBytes += object.Size!;
        if (totalBytes > config.maxArtifactBytes) throw new Error('Artifact size limit exceeded');
        const stored = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: object.Key }), { abortSignal: signal });
        if (!stored.Body) throw new Error('Legacy artifact body is missing');
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of stored.Body as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > object.Size!) throw new Error('Legacy artifact size mismatch');
          hash.update(chunk);
        }
        const sha256 = hash.digest('hex');
        if (size !== object.Size || stored.Metadata?.sha256 !== sha256) throw new Error('Legacy artifact checksum mismatch');
        files.push({ key, size, sha256 });
      }
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && !continuation) throw new Error('Artifact listing did not return a continuation token');
    } while (continuation);
    manifest = parseArtifactManifest({ version: 1, deploymentId, files: files.sort((a, b) => a.key.localeCompare(b.key)), totalBytes }, deploymentId);
    try { await writeManifest(manifest, signal); }
    catch (error) {
      if (![409, 412].includes((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0)) throw error;
      const existing = await readManifest(deploymentId, undefined, signal);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(manifest)) throw new Error('Artifact manifest conflicts with existing version');
    }
    return manifest;
  }
  for (const file of manifest.files) await verifyStoredFile(prefix, file, signal);
  return manifest;
}

export function getArtifact(deploymentId: string, key: string, attemptId?: string) {
  return s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: versionPrefix(deploymentId, attemptId) + outputKey(key) }));
}

export async function deleteAttemptArtifacts(deploymentId: string, token: string, signal?: AbortSignal): Promise<void> {
  requireUuid(token);
  const prefix = versionPrefix(deploymentId, token);
  const deadline = AbortSignal.any([AbortSignal.timeout(config.buildTimeoutMs), ...(signal ? [signal] : [])]);
  let deleted = 0;
  for (;;) {
    deadline.throwIfAborted();
    const page = await s3.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: prefix, MaxKeys: 1000 }), { abortSignal: deadline });
    const objects = (page.Contents ?? []).slice(0, 1000).map(object => {
      if (!object.Key?.startsWith(prefix)) throw new Error('Refusing deletion outside the attempt prefix');
      return { Key: object.Key };
    });
    if (!objects.length) {
      if (page.IsTruncated) throw new Error('Artifact listing returned an empty truncated page');
      return;
    }
    if (deleted + objects.length > 10_000) throw new Error('Attempt cleanup deletion limit exceeded');
    const result = await s3.send(new DeleteObjectsCommand({ Bucket: config.s3Bucket, Delete: { Objects: objects } }), { abortSignal: deadline });
    if (result.Errors?.length) throw new Error('Could not delete all attempt artifacts');
    deleted += objects.length;
    // Restart listing after deletion so continuation tokens cannot skip objects on compatible stores.
  }
}
