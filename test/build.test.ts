import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildRepository } from '../src/build.js';
import { config } from '../src/config.js';

const deploymentId = '11111111-1111-4111-8111-111111111111';
const commitSha = 'a'.repeat(40);
const repoUrl = 'https://github.com/example/site.git';

function fakeDocker(t: TestContext, behavior?: (args: string[]) => 'hang' | 'fail' | undefined) {
  const calls: string[][] = [];
  t.mock.method(childProcess, 'spawn', (command: string, args: string[]) => {
    assert.equal(command, 'docker');
    calls.push(args);
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    child.stdout = stdout;
    child.stderr = stderr;
    let closed = false;
    function close(code: number | null) {
      if (closed) return;
      closed = true;
      stdout.end();
      stderr.end();
      child.emit('close', code);
    }
    child.kill = () => { queueMicrotask(() => close(null)); return true; };
    queueMicrotask(async () => {
      try {
        const action = behavior?.(args);
        if (action === 'hang') return;
        if (action === 'fail') { stderr.write('Fixture cleanup failed'); close(1); return; }
        if (args[0] === 'inspect') stdout.write('0\n');
        if (args[0] === 'cp') {
          if (args[1].endsWith(':/work/commit')) await writeFile(args[2], `${commitSha}\n`);
          else { await mkdir(args[2]); await writeFile(join(args[2], 'index.html'), '<h1>Fixture</h1>'); }
        }
        close(0);
      } catch (error) { child.emit('error', error); close(1); }
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test('each build labels its named resources and cleanup failures do not mask successful publication', async t => {
  const token = randomUUID();
  const calls = fakeDocker(t, args => args[0] === 'rm' || args[0] === 'volume' && args[1] === 'rm' ? 'fail' : undefined);
  const errors: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
  let artifactDirectory = '';
  await buildRepository(deploymentId, token, repoUrl, commitSha, () => {}, async (directory, sha, signal) => {
    assert.equal(sha, commitSha);
    assert.equal(signal.aborted, false);
    assert.ok(directory.includes(`${token}-`));
    await access(join(directory, 'index.html'));
    artifactDirectory = directory;
  });
  const volume = calls.find(args => args[0] === 'volume' && args[1] === 'create')!;
  for (const label of ['shipyard.managed=true', `shipyard.claim=${token}`, `shipyard.deployment=${deploymentId}`]) assert.ok(volume.includes(label));
  assert.equal(volume.at(-1), `shipyard-work-${token}`);
  assert.ok(calls.some(args => args[0] === 'rm' && args.at(-1) === `shipyard-${deploymentId}-${token}`));
  assert.ok(calls.some(args => args[0] === 'volume' && args[1] === 'rm' && args.at(-1) === `shipyard-work-${token}`));
  assert.equal(errors.length, 2);
  await assert.rejects(access(artifactDirectory), { code: 'ENOENT' });
});

test('losing a claim aborts the running Docker command but still removes its resources', async t => {
  const controller = new AbortController();
  const reason = new Error('Claim expired');
  const token = randomUUID();
  const calls = fakeDocker(t, args => {
    if (args[0] === 'start') { controller.abort(reason); return 'hang'; }
    return undefined;
  });
  let published = false;
  await assert.rejects(buildRepository(deploymentId, token, repoUrl, null, () => {}, async () => { published = true; }, controller.signal), error => error === reason);
  assert.equal(published, false);
  assert.deepEqual(calls.slice(-2), [
    ['rm', '--force', `shipyard-${deploymentId}-${token}`],
    ['volume', 'rm', '--force', `shipyard-work-${token}`],
  ]);
});

test('the build deadline also cancels publication and leaves cleanup able to run', async t => {
  const previousTimeout = config.buildTimeoutMs;
  config.buildTimeoutMs = 500;
  t.after(() => { config.buildTimeoutMs = previousTimeout; });
  const calls = fakeDocker(t);
  let publishing = false;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(buildRepository(deploymentId, randomUUID(), repoUrl, null, () => {}, async (_directory, _sha, signal) => {
      publishing = true;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }), { name: 'TimeoutError' });
  } finally { clearInterval(keepAlive); }
  assert.equal(publishing, true);
  assert.equal(calls.at(-2)?.[0], 'rm');
  assert.deepEqual(calls.at(-1)?.slice(0, 2), ['volume', 'rm']);
});
