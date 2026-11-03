import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { config } from './config.js';
import { runCommand } from './process.js';
import { requireUuid } from './validation.js';

export function containerArguments(id: string, token: string, repoUrl: string, commitSha?: string | null): string[] {
  requireUuid(id);
  requireUuid(token);
  if (commitSha !== undefined && commitSha !== null && !/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Invalid pinned Git commit');
  return [
    'create', '--name', `shipyard-${id}-${token}`, '--pull=never', '--network', 'bridge',
    '--label', 'shipyard.managed=true', '--label', `shipyard.claim=${token}`, '--label', `shipyard.deployment=${id}`,
    '--read-only', '--user', '1000:1000', '--cpus', String(config.buildCpus),
    '--memory', `${config.buildMemoryMb}m`, '--memory-swap', `${config.buildMemoryMb}m`,
    '--pids-limit', String(config.buildPids), '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true', '--mount', `type=volume,source=shipyard-work-${token},destination=/work`,
    '--tmpfs', '/tmp:rw,nosuid,size=268435456,uid=1000,gid=1000',
    '--log-driver', 'local', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=1', '--log-opt', 'compress=false',
    '--entrypoint', '/usr/bin/timeout',
    config.buildImage, '--signal=TERM', '--kill-after=10s', `${config.buildTimeoutMs / 1000}s`, '/usr/local/bin/shipyard-build', repoUrl, ...(commitSha ? [commitSha] : []),
  ];
}

export async function buildRepository(
  id: string,
  token: string,
  repoUrl: string,
  pinnedCommitSha: string | null,
  log: (stream: 'stdout' | 'stderr' | 'system', message: string) => void,
  publish: (directory: string, commitSha: string, signal: AbortSignal) => Promise<void>,
  leaseSignal?: AbortSignal,
): Promise<void> {
  const args = containerArguments(id, token, repoUrl, pinnedCommitSha);
  leaseSignal?.throwIfAborted();
  const name = `shipyard-${id}-${token}`;
  const volume = `shipyard-work-${token}`;
  const deadline = Date.now() + config.buildTimeoutMs;
  const signal = AbortSignal.any([AbortSignal.timeout(config.buildTimeoutMs), ...(leaseSignal ? [leaseSignal] : [])]);
  const workspaceRoot = join(tmpdir(), 'shipyard-builds');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  signal.throwIfAborted();
  const workspace = await mkdtemp(join(workspaceRoot, `${token}-`));
  const docker = (args: string[], stream = false) => {
    signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Build exceeded ${config.buildTimeoutMs} ms`);
    return runCommand('docker', args, { timeoutMs: remaining, onOutput: stream ? log : undefined, signal });
  };
  try {
    log('system', `Checking out ${pinnedCommitSha ?? 'main'} and building the Vite app in Docker.\n`);
    await docker(['volume', 'create', '--label', 'shipyard.managed=true', '--label', `shipyard.claim=${token}`, '--label', `shipyard.deployment=${id}`, volume]);
    await docker(args);
    await docker(['start', '--attach', name], true);
    const exitCode = (await docker(['inspect', '--format', '{{.State.ExitCode}}', name])).trim();
    if (exitCode !== '0') throw new Error(`Build container exited with code ${exitCode}`);
    await docker(['cp', `${name}:/work/commit`, join(workspace, 'commit')]);
    const commitSha = (await readFile(join(workspace, 'commit'), 'utf8')).trim();
    if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('Build returned an invalid Git commit');
    if (pinnedCommitSha && commitSha !== pinnedCommitSha) throw new Error('Build returned a different Git commit than requested');
    await docker(['cp', `${name}:/work/repo/dist`, join(workspace, 'artifacts')]);
    log('system', 'Build finished. Validating and uploading artifacts.\n');
    signal.throwIfAborted();
    await publish(join(workspace, 'artifacts'), commitSha, signal);
  } finally {
    // Cleanup must still run after lease cancellation; labels let the janitor recover a worker crash.
    try { await runCommand('docker', ['rm', '--force', name], { timeoutMs: 15_000 }); }
    catch (error) { console.error(`Could not clean build container ${name}`, error); }
    try { await runCommand('docker', ['volume', 'rm', '--force', volume], { timeoutMs: 15_000 }); }
    catch (error) { console.error(`Could not clean build volume ${volume}`, error); }
    try {
      if (!resolve(workspace).startsWith(resolve(workspaceRoot) + sep)) throw new Error('Workspace cleanup escaped build root');
      await rm(workspace, { recursive: true, force: true });
    }
    catch (error) { console.error(`Could not clean temporary workspace ${workspace}`, error); }
  }
}
