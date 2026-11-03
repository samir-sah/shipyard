import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('setup creates private credentials once and preserves existing operator settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shipyard-setup-'));
  const script = resolve('scripts/setup.mjs');
  try {
    await writeFile(join(directory, '.env.example'), 'DATABASE_URL=postgres://example\nAUTH_USERS=[]\nSESSION_SECRET=\nGITHUB_WEBHOOK_KEY=\n');
    const first = await promisify(execFile)(process.execPath, [script], { cwd: directory });
    const source = await readFile(join(directory, '.env'), 'utf8');
    const users = JSON.parse(/^AUTH_USERS=(.+)$/m.exec(source)![1]);
    assert.equal(users[0].id, '00000000-0000-4000-8000-000000000001');
    assert.match(users[0].token, /^[a-f0-9]{64}$/);
    assert.match(source, /^SESSION_SECRET=[a-f0-9]{64}$/m);
    assert.match(source, /^GITHUB_WEBHOOK_KEY=[a-f0-9]{64}$/m);
    assert.ok(!first.stdout.includes(users[0].token));
    await promisify(execFile)(process.execPath, [script], { cwd: directory });
    assert.equal(await readFile(join(directory, '.env'), 'utf8'), source);
    assert.match(source, /^DATABASE_URL=postgres:\/\/example$/m);
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true });
  }
});
