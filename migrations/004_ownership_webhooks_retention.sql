ALTER TABLE projects ADD COLUMN owner_id uuid NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001';
ALTER TABLE projects ADD COLUMN webhook_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD COLUMN webhook_key_version integer NOT NULL DEFAULT 0 CHECK (webhook_key_version >= 0);
ALTER TABLE deployments ADD COLUMN retained boolean NOT NULL DEFAULT false;
ALTER TABLE deployments ADD COLUMN artifact_state text NOT NULL DEFAULT 'available' CHECK (artifact_state IN ('available', 'deleting', 'deleted'));

CREATE TABLE webhook_deliveries (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  payload_hash text NOT NULL,
  event_type text NOT NULL,
  deployment_id uuid REFERENCES deployments(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, delivery_id)
);

CREATE INDEX projects_owner ON projects(owner_id, created_at DESC);
CREATE INDEX deployments_retention ON deployments(finished_at, id) WHERE status = 'deployed' AND artifact_state = 'available';
CREATE INDEX deployments_deleting ON deployments(id) WHERE artifact_state = 'deleting';
