export type DeploymentStatus = 'queued' | 'building' | 'failed' | 'deployed';

export interface ArtifactManifest {
  version: 1;
  deploymentId: string;
  files: Array<{ key: string; size: number; sha256: string }>;
  totalBytes: number;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  repoUrl: string;
  branch: 'main';
  activeDeploymentId: string | null;
  createdAt: string;
}

export interface Deployment {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  commitSha: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  queueWaitMs: number | null;
  buildDurationMs: number | null;
  logTruncated: boolean;
}

export interface DeploymentLog {
  id: number;
  stream: 'system' | 'stdout' | 'stderr';
  message: string;
  createdAt: string;
}
