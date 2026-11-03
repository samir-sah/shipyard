import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deploy } from '../../src/deployment.js';
import { s3 } from '../../src/storage.js';

const [id, phase] = process.argv.slice(2);
let workspace = '';
s3.middlewareStack.add((next, context) => async args => {
  const response = await next(args);
  const key = (args.input as { Key?: string }).Key;
  if (context.commandName === 'PutObjectCommand' && key && (phase === 'manifest' ? key.endsWith('__shipyard_manifest.json') : !key.endsWith('__shipyard_manifest.json'))) {
    process.stdout.write(`${JSON.stringify({ event: 'uploaded', key, workspace })}\n`);
    await new Promise(() => {});
  }
  return response;
}, { name: 'pauseAfterStoredObject', step: 'initialize' });

await deploy(id, 1, async (_id, token, _url, pinned, _log, publish, signal) => {
  const root = join(tmpdir(), 'shipyard-builds');
  await mkdir(root, { recursive: true });
  workspace = await mkdtemp(join(root, `${token}-`));
  await writeFile(join(workspace, 'index.html'), '<h1>Crash recovery fixture</h1>');
  await writeFile(join(workspace, 'app.js'), 'console.log("fixture")');
  await publish(workspace, pinned ?? 'a'.repeat(40), signal!);
});
