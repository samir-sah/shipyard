import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../../src/config.js';
import { s3, ensureBucket, uploadArtifacts, getArtifact } from '../../src/storage.js';

test('S3 upload validates and serves the exact artifact bytes', { skip: process.env.RUN_INTEGRATION !== '1' }, async () => {
  const id = randomUUID();
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-s3-'));
  try {
    await ensureBucket();
    await writeFile(join(directory, 'index.html'), '<h1>Verified deployment</h1>');
    await uploadArtifacts(id, directory, AbortSignal.timeout(30_000));
    const result = await getArtifact(id, 'index.html');
    assert.equal(await result.Body?.transformToString(), '<h1>Verified deployment</h1>');
    assert.equal(result.ContentType, 'text/html');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(uploadArtifacts(randomUUID(), directory, controller.signal));
  } finally {
    await s3.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: `deployments/${id}/index.html` })).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    s3.destroy();
  }
});
