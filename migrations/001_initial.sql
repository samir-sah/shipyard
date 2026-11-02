CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  repo_url text NOT NULL,
  branch text NOT NULL DEFAULT 'main' CHECK (branch = 'main'),
  active_deployment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deployments (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'failed', 'deployed')),
  commit_sha text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  log_bytes integer NOT NULL DEFAULT 0 CHECK (log_bytes >= 0),
  log_truncated boolean NOT NULL DEFAULT false,
  UNIQUE (project_id, id)
);

ALTER TABLE projects ADD CONSTRAINT active_deployment_belongs_to_project
  FOREIGN KEY (id, active_deployment_id) REFERENCES deployments(project_id, id);
CREATE INDEX deployments_project_history ON deployments(project_id, created_at DESC);
CREATE INDEX deployments_queued ON deployments(created_at) WHERE status = 'queued';

CREATE TABLE deployment_logs (
  id bigserial PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id),
  stream text NOT NULL CHECK (stream IN ('system', 'stdout', 'stderr')),
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deployment_logs_cursor ON deployment_logs(deployment_id, id);
