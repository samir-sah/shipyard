import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { deleteAttemptArtifacts, getArtifact, inspectArtifacts, parseArtifactManifest, uploadArtifacts } from '../src/storage.js';
import type { ArtifactManifest } from '../src/contracts.js';

const deploymentId = '0f85a743-22bb-4cde-b162-11783d69d5a0';

function manifest(): ArtifactManifest {
  return {
    version: 1, deploymentId,
    files: [
      { key: 'index.html', size: 12, sha256: 'a'.repeat(64) },
      { key: 'assets/app.js', size: 8, sha256: 'b'.repeat(64) },
    ],
    totalBytes: 20,
  };
}

test('accepts a complete deployment manifest, including an empty artifact file', () => {
  const input = manifest();
  assert.deepEqual(parseArtifactManifest(input, deploymentId), input);
  input.files[1].size = 0;
  input.totalBytes = 12;
  assert.deepEqual(parseArtifactManifest(input, deploymentId), input);
});

test('accepts legacy manifests and requires a valid attempt ID and pinned commit together', () => {
  const input = { ...manifest(), attemptId: randomUUID(), commitSha: 'c'.repeat(40) };
  assert.deepEqual(parseArtifactManifest(input, deploymentId), input);
  for (const fields of [
    { attemptId: input.attemptId }, { commitSha: input.commitSha },
    { attemptId: 'invalid', commitSha: input.commitSha },
    { attemptId: null, commitSha: input.commitSha },
    { attemptId: input.attemptId, commitSha: 'c'.repeat(39) },
    { attemptId: input.attemptId, commitSha: 'z'.repeat(40) },
    { attemptId: input.attemptId, commitSha: null },
  ]) assert.throws(() => parseArtifactManifest({ ...manifest(), ...fields }, deploymentId));
});

test('rejects invalid attempt prefixes and cancels cleanup before S3 I/O', async () => {
  const token = randomUUID();
  assert.throws(() => getArtifact(deploymentId, 'index.html', '../other'));
  await assert.rejects(deleteAttemptArtifacts(deploymentId, '../other'));
  await assert.rejects(deleteAttemptArtifacts('invalid', token));
  await assert.rejects(deleteAttemptArtifacts(deploymentId, undefined as unknown as string));
  const reason = new Error('cleanup cancelled before I/O');
  await assert.rejects(deleteAttemptArtifacts(deploymentId, token, AbortSignal.abort(reason)), error => error === reason);
  await assert.rejects(uploadArtifacts(deploymentId, 'does-not-exist', undefined, { token: 'invalid', commitSha: 'a'.repeat(40) }), /Invalid ID/);
  await assert.rejects(uploadArtifacts(deploymentId, 'does-not-exist', undefined, { token, commitSha: 'bad' }), /Invalid artifact commit/);
});

test('rejects malformed manifests before trusting their version or paths', () => {
  const invalid: unknown[] = [
    null, [], 'manifest', {},
    { ...manifest(), version: 2 },
    { ...manifest(), deploymentId: randomUUID() },
    { ...manifest(), deploymentId: 'invalid-id' },
    { ...manifest(), files: null },
    { ...manifest(), files: [] },
    { ...manifest(), files: [null] },
    { ...manifest(), totalBytes: '20' },
    { ...manifest(), totalBytes: -20 },
    { ...manifest(), totalBytes: 19 },
    { ...manifest(), totalBytes: Infinity },
  ];
  for (const input of invalid) assert.throws(() => parseArtifactManifest(input, deploymentId));
  assert.throws(() => parseArtifactManifest(manifest(), 'invalid-id'));
  for (const key of ['../index.html', '/index.html', 'assets/../app.js', 'assets//app.js', 'assets\\app.js', 'index.html\0', '__shipyard_manifest.json']) {
    const input = manifest();
    input.files[1].key = key;
    assert.throws(() => parseArtifactManifest(input, deploymentId), `accepted unsafe or reserved path ${JSON.stringify(key)}`);
  }
});

test('rejects duplicate entries, missing index and invalid hashes or file sizes', () => {
  const duplicate = manifest();
  duplicate.files[1].key = 'index.html';
  assert.throws(() => parseArtifactManifest(duplicate, deploymentId));
  const noIndex = manifest();
  noIndex.files[0].key = 'other.html';
  assert.throws(() => parseArtifactManifest(noIndex, deploymentId));
  for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '8']) {
    const input = manifest();
    (input.files[1] as unknown as Record<string, unknown>).size = size;
    assert.throws(() => parseArtifactManifest(input, deploymentId));
  }
  for (const sha256 of ['', 'a'.repeat(63), 'g'.repeat(64), null, 123]) {
    const input = manifest();
    (input.files[1] as unknown as Record<string, unknown>).sha256 = sha256;
    assert.throws(() => parseArtifactManifest(input, deploymentId));
  }
});

test('enforces artifact count and total-byte limits in stored manifests', () => {
  const oversized = manifest();
  oversized.files[0].size = config.maxArtifactBytes + 1;
  oversized.totalBytes = config.maxArtifactBytes + 9;
  assert.throws(() => parseArtifactManifest(oversized, deploymentId));
  const tooMany = manifest();
  tooMany.files = Array.from({ length: config.maxArtifactFiles + 1 }, (_, index) => ({ key: index ? `assets/file-${index}.js` : 'index.html', size: 0, sha256: 'a'.repeat(64) }));
  tooMany.totalBytes = 0;
  assert.throws(() => parseArtifactManifest(tooMany, deploymentId));
});

test('reserves the completion marker and stops pre-aborted uploads before filesystem or S3 I/O', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-reserved-'));
  try {
    await writeFile(join(directory, 'index.html'), 'ok');
    await writeFile(join(directory, '__shipyard_manifest.json'), '{}');
    await assert.rejects(inspectArtifacts(directory));
    const reason = new Error('upload cancelled before I/O');
    await assert.rejects(uploadArtifacts(randomUUID(), join(directory, 'does-not-exist'), AbortSignal.abort(reason)), error => error === reason);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
