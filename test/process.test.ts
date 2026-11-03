import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/process.js';
import { containerArguments } from '../src/build.js';

test('command arguments remain literal, without shell interpolation', async () => {
  const value = '; echo unsafe && $(whoami)';
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value], { timeoutMs: 5_000 });
  assert.equal(result, value);
});

test('failed commands report exit status and output', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'console.error("fixture failed");process.exit(7)'], { timeoutMs: 5_000 }), /code 7: fixture failed/);
});

test('hung commands are terminated at the deadline', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), /exceeded 100 ms/);
});

test('an aborted lease prevents a command from starting', async () => {
  const controller = new AbortController();
  const reason = new Error('Claim expired before start');
  controller.abort(reason);
  await assert.rejects(runCommand('shipyard-command-that-does-not-exist', [], { timeoutMs: 5_000, signal: controller.signal }), error => error === reason);
});

test('lease cancellation terminates a running command and preserves its reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Claim ownership lost');
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {
    timeoutMs: 5_000,
    signal: controller.signal,
    onOutput: (_stream, text) => { if (text.includes('ready')) controller.abort(reason); },
  }), error => error === reason);
});

test('Docker builds have resource limits and receive no host secrets or socket', () => {
  const url = 'https://github.com/example/site.git';
  const id = '11111111-1111-4111-8111-111111111111';
  const token = '22222222-2222-4222-8222-222222222222';
  const args = containerArguments(id, token, url);
  for (const flag of ['--read-only', '--cpus', '--memory', '--memory-swap', '--pids-limit', '--cap-drop', '--security-opt']) assert.ok(args.includes(flag));
  assert.equal(args.at(-1), url);
  assert.equal(args[args.indexOf('--name') + 1], `shipyard-${id}-${token}`);
  assert.ok(args.includes('shipyard.managed=true'));
  assert.ok(args.includes(`shipyard.claim=${token}`));
  assert.ok(args.includes(`shipyard.deployment=${id}`));
  assert.ok(args.includes(`type=volume,source=shipyard-work-${token},destination=/work`));
  assert.ok(!args.includes('--env'));
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.ok(!args.join(' ').includes('type=bind'));
  assert.throws(() => containerArguments('../escape', token, url));
  assert.throws(() => containerArguments(id, '../escape', url));
  assert.throws(() => containerArguments(id, token, url, 'main; exit 1'));
  const commitSha = 'a'.repeat(40);
  assert.deepEqual(containerArguments(id, token, url, commitSha).slice(-2), [url, commitSha]);
});
