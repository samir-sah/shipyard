import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectArtifacts } from '../src/storage.js';

test('validates complete output, nested files and hashes before publishing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-artifacts-'));
  try {
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<h1>Shipyard</h1>');
    await writeFile(join(directory, 'assets', 'app.js'), 'console.log(1)');
    const files = await inspectArtifacts(directory);
    assert.deepEqual(files.map(file => file.key).sort(), ['assets/app.js', 'index.html']);
    assert.ok(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    await assert.rejects(inspectArtifacts(directory, { maxBytes: 1, maxFiles: 10 }), /limit exceeded/);
    await assert.rejects(inspectArtifacts(directory, { maxBytes: 1024, maxFiles: 1 }), /limit exceeded/);
    await rm(join(directory, 'index.html'));
    await assert.rejects(inspectArtifacts(directory), /index.html/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('refuses environment and Git configuration files before uploading output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-sensitive-'));
  try {
    await writeFile(join(directory, 'index.html'), 'ok');
    await writeFile(join(directory, '.env.production'), 'SECRET=fixture');
    await assert.rejects(inspectArtifacts(directory), /Sensitive configuration/);
    await rm(join(directory, '.env.production'));
    await mkdir(join(directory, '.git'));
    await assert.rejects(inspectArtifacts(directory), /Sensitive configuration/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('rejects symlinks rather than reading outside the output tree', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-link-'));
  try {
    await writeFile(join(directory, 'index.html'), 'ok');
    try { await symlink(join(directory, 'index.html'), join(directory, 'link.html')); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Host does not grant symlink creation'); return; }
      throw error;
    }
    await assert.rejects(inspectArtifacts(directory), /Unsupported artifact/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('bounds empty directories and deeply nested output as well as regular files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-tree-'));
  try {
    await writeFile(join(directory, 'index.html'), 'ok');
    let nested = directory;
    for (let depth = 0; depth < 33; depth++) {
      nested = join(nested, 'd');
      await mkdir(nested);
    }
    await assert.rejects(inspectArtifacts(directory), /depth limit/);
    await assert.rejects(inspectArtifacts(directory, { maxBytes: 1024, maxFiles: 2 }), /directory count limit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
