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

test('Docker builds have resource limits and receive no host secrets or socket', () => {
  const url = 'https://github.com/example/site.git';
  const args = containerArguments('11111111-1111-4111-8111-111111111111', url);
  for (const flag of ['--read-only', '--cpus', '--memory', '--memory-swap', '--pids-limit', '--cap-drop', '--security-opt']) assert.ok(args.includes(flag));
  assert.equal(args.at(-1), url);
  assert.ok(!args.includes('--env'));
  assert.ok(!args.join(' ').includes('docker.sock'));
  assert.ok(!args.join(' ').includes('type=bind'));
  assert.throws(() => containerArguments('../escape', url));
});
