import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../../src/config.js';
import { s3, ensureBucket, uploadArtifacts, getArtifact, validateStoredVersion } from '../../src/storage.js';
import type { ArtifactManifest } from '../../src/contracts.js';

const marker = '__shipyard_manifest.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
after(() => s3.destroy());

async function cleanupDeployment(id: string): Promise<void> {
  const prefix = `deployments/${id}/`;
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: config.s3Bucket, Prefix: prefix, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      const key = object.Key;
      assert.ok(key);
      assert.ok(key.startsWith(prefix), 'refuse cleanup outside this test deployment');
      keys.push(key);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated) assert.ok(token, 'S3 omitted its continuation token');
  } while (token);
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const result = await s3.send(new DeleteObjectsCommand({ Bucket: config.s3Bucket, Delete: { Objects: keys.slice(offset, offset + 1000).map(Key => ({ Key })) } }));
    assert.equal(result.Errors?.length ?? 0, 0, 'test artifact cleanup failed');
  }
}

async function put(id: string, key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: `deployments/${id}/${key}`, Body: body, Metadata: { sha256: hash(body) } }));
}

async function readMarker(id: string): Promise<ArtifactManifest> {
  const result = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: `deployments/${id}/${marker}` }));
  return JSON.parse(await result.Body!.transformToString()) as ArtifactManifest;
}

test('S3 versions are complete, immutable and validated before reuse', { skip: process.env.RUN_INTEGRATION !== '1', timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-s3-'));
  const ids: string[] = [];
  const nextId = () => { const id = randomUUID(); ids.push(id); return id; };
  const html = '<h1>Verified deployment</h1>';
  const script = 'console.log("artifact")';
  try {
    await ensureBucket();
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), html);
    await writeFile(join(directory, 'assets', 'app.js'), script);
    await t.test('roundtrips the marker, exact manifest and artifact content without allowing overwrite', async () => {
      const id = nextId();
      const manifest = await uploadArtifacts(id, directory, AbortSignal.timeout(30_000));
      assert.equal(manifest.deploymentId, id);
      assert.equal(manifest.totalBytes, Buffer.byteLength(html) + Buffer.byteLength(script));
      assert.deepEqual(manifest.files.map(file => file.key).sort(), ['assets/app.js', 'index.html']);
      assert.deepEqual(await readMarker(id), manifest);
      assert.deepEqual(await validateStoredVersion(id), manifest);
      const result = await getArtifact(id, 'index.html');
      assert.equal(await result.Body?.transformToString(), html);
      assert.equal(result.ContentType, 'text/html');
      await writeFile(join(directory, 'index.html'), '<h1>Overwrite attempt</h1>');
      await assert.rejects(uploadArtifacts(id, directory, AbortSignal.timeout(30_000)));
      assert.equal(await (await getArtifact(id, 'index.html')).Body?.transformToString(), html);
      assert.deepEqual(await readMarker(id), manifest);
      assert.deepEqual(await validateStoredVersion(id), manifest);
      await writeFile(join(directory, 'index.html'), html);
    });
    await t.test('never treats an unsealed new prefix as a complete version', async () => {
      const id = nextId();
      await put(id, 'index.html', html);
      await assert.rejects(validateStoredVersion(id));
      await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: `deployments/${id}/${marker}` })), error => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404);
    });
    await t.test('rejects an incomplete legacy prefix without index.html', async () => {
      const id = nextId();
      await put(id, 'assets/app.js', script);
      await assert.rejects(validateStoredVersion(id, { allowLegacy: true }));
      await assert.rejects(s3.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: `deployments/${id}/${marker}` })), error => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404);
    });
    await t.test('seals an explicitly allowed M1 prefix and validates it normally thereafter', async () => {
      const id = nextId();
      await put(id, 'index.html', html);
      await put(id, 'assets/app.js', script);
      const manifest = await validateStoredVersion(id, { allowLegacy: true });
      assert.equal(manifest.deploymentId, id);
      assert.equal(manifest.totalBytes, Buffer.byteLength(html) + Buffer.byteLength(script));
      assert.deepEqual(await readMarker(id), manifest);
      assert.deepEqual(await validateStoredVersion(id), manifest);
    });
    await t.test('rejects a completed version after an object changes or disappears', async () => {
      const changedId = nextId();
      await uploadArtifacts(changedId, directory, AbortSignal.timeout(30_000));
      const tampered = script.replace('artifact', 'tampered');
      assert.equal(Buffer.byteLength(tampered), Buffer.byteLength(script));
      await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: `deployments/${changedId}/assets/app.js`, Body: tampered, Metadata: { sha256: hash(script) } }));
      await assert.rejects(validateStoredVersion(changedId));
      const missingId = nextId();
      await uploadArtifacts(missingId, directory, AbortSignal.timeout(30_000));
      await s3.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: `deployments/${missingId}/assets/app.js` }));
      await assert.rejects(validateStoredVersion(missingId));
    });
  } finally {
    try {
      const cleanups = await Promise.allSettled(ids.map(cleanupDeployment));
      const failures = cleanups.filter(result => result.status === 'rejected');
      assert.deepEqual(failures, [], 'could not clean every test deployment prefix');
    }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
