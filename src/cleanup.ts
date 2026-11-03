import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { isClaimActive, listAbandonedAttempts, markAttemptCleaned } from './db.js';
import { deleteAttemptArtifacts } from './storage.js';
import { runCommand } from './process.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

async function cleanDocker(signal?: AbortSignal): Promise<void> {
  const docker = (args: string[]) => runCommand('docker', args, { timeoutMs: 15_000, signal });
  const containers = (await docker(['ps', '--all', '--quiet', '--filter', 'label=shipyard.managed=true'])).trim().split(/\s+/).filter(Boolean).slice(0, 100);
  for (const container of containers) {
    signal?.throwIfAborted();
    if (!/^[a-f0-9]{12,64}$/.test(container)) continue;
    try {
      const labels = JSON.parse(await docker(['inspect', '--format', '{{json .Config.Labels}}', container])) as Record<string, string>;
      const token = labels['shipyard.claim'];
      if (!new RegExp(`^${uuid}$`, 'i').test(token ?? '') || await isClaimActive(token)) continue;
      await docker(['rm', '--force', '--volumes', container]);
    } catch (error) { if (signal?.aborted) throw error; console.error('Abandoned container cleanup failed', container, error); }
  }
  const volumes = (await docker(['volume', 'ls', '--quiet', '--filter', 'label=shipyard.managed=true'])).trim().split(/\s+/).filter(Boolean).slice(0, 100);
  for (const volume of volumes) {
    const match = new RegExp(`^shipyard-work-(${uuid})$`, 'i').exec(volume);
    if (!match || await isClaimActive(match[1])) continue;
    try { await docker(['volume', 'rm', volume]); }
    catch (error) { if (signal?.aborted) throw error; console.error('Abandoned volume cleanup failed', volume, error); }
  }
}

async function cleanWorkspaces(signal?: AbortSignal): Promise<void> {
  const root = resolve(join(tmpdir(), 'shipyard-builds'));
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries.slice(0, 100)) {
    signal?.throwIfAborted();
    const match = new RegExp(`^(${uuid})-[a-z0-9]+$`, 'i').exec(entry.name);
    if (!entry.isDirectory() || !match || await isClaimActive(match[1])) continue;
    const target = resolve(root, entry.name);
    if (!target.startsWith(root + sep)) throw new Error('Refusing cleanup outside build workspace root');
    await rm(target, { recursive: true, force: true });
  }
}

export async function cleanupBuildResources(signal?: AbortSignal): Promise<void> {
  const results = await Promise.allSettled([cleanDocker(signal), cleanWorkspaces(signal)]);
  for (const result of results) if (result.status === 'rejected' && !signal?.aborted) console.error('Build resource cleanup failed', result.reason);
  for (const attempt of await listAbandonedAttempts(10)) {
    signal?.throwIfAborted();
    try { await deleteAttemptArtifacts(attempt.deploymentId, attempt.token, signal); }
    catch (error) { if (signal?.aborted) throw error; console.error('Abandoned artifact cleanup failed', attempt.token, error); }
    finally { await markAttemptCleaned(attempt.token); }
  }
}
