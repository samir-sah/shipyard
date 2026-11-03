import { config } from './config.js';
import { appendLog, claimDeployment, activateDeployment, failDeployment, renewClaim, recordDeploymentCommit } from './db.js';
import { uploadArtifacts } from './storage.js';
import { buildRepository } from './build.js';
import type { ArtifactManifest } from './contracts.js';

export async function deploy(id: string, expectedAttempt: number, build = buildRepository): Promise<void> {
  const claim = await claimDeployment(id, expectedAttempt);
  if (!claim) return;
  const controller = new AbortController();
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal || controller.signal.aborted) return;
    renewal = renewClaim(id, claim.token).then(owned => {
      if (!owned) controller.abort(new Error('Worker claim expired or changed'));
    }).catch(error => controller.abort(error)).finally(() => { renewal = undefined; });
  }, Math.max(1, Math.floor(config.workerLeaseMs / 3)));
  let pendingLogs = Promise.resolve();
  let bytes = 0;
  const log = (stream: 'stdout' | 'stderr' | 'system', message: string) => {
    if (bytes > config.maxLogBytes || controller.signal.aborted) return;
    bytes += Buffer.byteLength(message);
    pendingLogs = pendingLogs.then(() => appendLog(id, stream, message, claim.token));
    void pendingLogs.catch(() => {});
  };
  try {
    log('system', `Starting attempt ${claim.attempt}/${config.maxBuildAttempts}.\n`);
    let commitSha = '';
    let manifest: ArtifactManifest | undefined;
    await build(id, claim.token, claim.repoUrl, claim.commitSha, log, async (directory, sha, signal) => {
      signal.throwIfAborted();
      if (!await recordDeploymentCommit(id, claim.token, sha)) throw new Error('Cannot pin commit after claim loss or commit change');
      manifest = await uploadArtifacts(id, directory, signal, { token: claim.token, commitSha: sha });
      commitSha = sha;
    }, controller.signal);
    await pendingLogs;
    controller.signal.throwIfAborted();
    if (!manifest) throw new Error('Build did not produce a complete artifact version');
    const publication = await activateDeployment(id, claim.token, commitSha, manifest);
    if (!publication) throw new Error('Worker claim no longer permits publication');
    await appendLog(id, 'system', publication === 'active' ? 'Deployment is live.\n' : 'Build retained as a version. A newer deployment request or rollback controls the active site.\n').catch(error => console.error('Could not persist completion log', error));
  } catch (error) {
    controller.abort(error);
    const message = error instanceof Error ? error.message : String(error);
    await pendingLogs.catch(logError => console.error('Could not persist build logs', logError));
    const outcome = await failDeployment(id, claim.token, message);
    if (outcome) await appendLog(id, 'system', `Attempt ${claim.attempt} failed: ${message}. ${outcome === 'retry' ? 'Retry scheduled.' : 'Attempt limit reached.'}\n`).catch(console.error);
    throw error;
  } finally {
    clearInterval(heartbeat);
    await renewal;
    controller.abort(new Error('Attempt finished'));
  }
}
