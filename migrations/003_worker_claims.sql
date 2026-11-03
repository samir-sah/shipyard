ALTER TABLE deployments ADD COLUMN claim_token uuid;
ALTER TABLE deployments ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE deployments ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);
ALTER TABLE deployments ADD COLUMN retry_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE build_attempts (
  token uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('building', 'completed', 'failed', 'expired')),
  error text,
  last_cleanup_at timestamptz,
  UNIQUE (deployment_id, attempt_number)
);

CREATE INDEX deployments_expired_claims ON deployments(lease_expires_at) WHERE status = 'building';
CREATE INDEX build_attempts_cleanup ON build_attempts(last_cleanup_at, finished_at) WHERE status IN ('failed', 'expired');

UPDATE deployments SET status = 'queued', retry_at = clock_timestamp(), finished_at = NULL,
  error = concat_ws(E'\n', nullif(error, ''), 'Requeued during worker-claim upgrade')
WHERE status = 'building';
