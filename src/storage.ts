import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { lookup } from 'mime-types';
import { config } from './config.js';
import { artifactKey, requireUuid } from './validation.js';

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
      const key = artifactKey(prefix + entry.name);
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

export async function uploadArtifacts(deploymentId: string, directory: string, signal?: AbortSignal): Promise<void> {
  requireUuid(deploymentId);
  signal?.throwIfAborted();
  const files = await inspectArtifacts(directory);
  for (const file of files) {
    signal?.throwIfAborted();
    const key = `deployments/${deploymentId}/${file.key}`;
    await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: createReadStream(file.path), ContentLength: file.size, ContentType: lookup(file.key) || 'application/octet-stream', Metadata: { sha256: file.sha256 } }), { abortSignal: signal });
    const stored = await s3.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }), { abortSignal: signal });
    if (stored.ContentLength !== file.size || stored.Metadata?.sha256 !== file.sha256) throw new Error(`Artifact validation failed: ${file.key}`);
  }
}

export function getArtifact(deploymentId: string, key: string) {
  requireUuid(deploymentId);
  return s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: `deployments/${deploymentId}/${artifactKey(key)}` }));
}
