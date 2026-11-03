import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const target = resolve('.env');
let source;
try { source = await readFile(target, 'utf8'); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  source = await readFile('.env.example', 'utf8');
}
const defaults = {
  AUTH_USERS: JSON.stringify([{ id: '00000000-0000-4000-8000-000000000001', name: 'Local operator', token: randomBytes(32).toString('hex') }]),
  SESSION_SECRET: randomBytes(32).toString('hex'),
  GITHUB_WEBHOOK_KEY: randomBytes(32).toString('hex'),
};
let changed = false;
for (const [name, value] of Object.entries(defaults)) {
  const line = new RegExp(`^${name}=(.*)$`, 'm');
  const existing = line.exec(source);
  if (existing && existing[1].trim() && existing[1].trim() !== '[]') continue;
  source = existing ? source.replace(line, `${name}=${value}`) : `${source.trimEnd()}\n${name}=${value}\n`;
  changed = true;
}
if (changed) await writeFile(target, source, { mode: 0o600 });
console.log(changed ? 'Configured .env. Copy the operator access token from AUTH_USERS to sign in. Keep .env private.' : 'Existing .env credentials preserved.');
