import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.js';
import { runCommand } from './process.js';
import { requireUuid } from './validation.js';

export function containerArguments(id: string, repoUrl: string): string[] {
  requireUuid(id);
  return [
    'create', '--name', `shipyard-${id}`, '--pull=never', '--network', 'bridge',
    '--read-only', '--user', '1000:1000', '--cpus', String(config.buildCpus),
    '--memory', `${config.buildMemoryMb}m`, '--memory-swap', `${config.buildMemoryMb}m`,
    '--pids-limit', String(config.buildPids), '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--mount', 'type=volume,destination=/work',
    '--tmpfs', '/tmp:rw,nosuid,size=268435456,uid=1000,gid=1000',
    '--log-driver', 'local', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=1',
    config.buildImage, repoUrl,
  ];
}

export async function buildRepository(
  id: string,
  repoUrl: string,
  log: (stream: 'stdout' | 'stderr' | 'system', message: string) => void,
  publish: (directory: string, commitSha: string, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const name = `shipyard-${id}`;
  const workspace = await mkdtemp(join(tmpdir(), 'shipyard-'));
  const deadline = Date.now() + config.buildTimeoutMs;
  const docker = (args: string[], stream = false) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Build exceeded ${config.buildTimeoutMs} ms`);
    return runCommand('docker', args, { timeoutMs: remaining, onOutput: stream ? log : undefined });
  };
  try {
    log('system', 'Checking out main and building the Vite app in Docker.\n');
    await docker(containerArguments(id, repoUrl));
    await docker(['start', '--attach', name], true);
    const exitCode = (await docker(['inspect', '--format', '{{.State.ExitCode}}', name])).trim();
    if (exitCode !== '0') throw new Error(`Build container exited with code ${exitCode}`);
    await docker(['cp', `${name}:/work/commit`, join(workspace, 'commit')]);
    const commitSha = (await readFile(join(workspace, 'commit'), 'utf8')).trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Build returned an invalid Git commit');
    await docker(['cp', `${name}:/work/repo/dist`, join(workspace, 'artifacts')]);
    log('system', 'Build finished. Validating and uploading artifacts.\n');
    await publish(join(workspace, 'artifacts'), commitSha, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
  } finally {
    // Always remove the stopped container and its anonymous work volume, including after a timeout.
    try { await runCommand('docker', ['rm', '--force', '--volumes', name], { timeoutMs: 15_000 }); }
    catch (error) { console.error(`Could not clean build container ${name}`, error); }
    try { await rm(workspace, { recursive: true, force: true }); }
    catch (error) { console.error(`Could not clean temporary workspace ${workspace}`, error); }
  }
}
