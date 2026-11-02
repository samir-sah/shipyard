ALTER TABLE projects ADD COLUMN publish_generation bigint NOT NULL DEFAULT 0 CHECK (publish_generation >= 0);
ALTER TABLE deployments ADD COLUMN publish_generation bigint NOT NULL DEFAULT 0 CHECK (publish_generation >= 0);
ALTER TABLE deployments ADD COLUMN artifact_manifest jsonb;

WITH ordered_deployments AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at, id) AS generation
  FROM deployments
)
UPDATE deployments d SET publish_generation = ordered.generation
FROM ordered_deployments ordered WHERE d.id = ordered.id;

UPDATE projects p SET publish_generation = (
  SELECT coalesce(max(d.publish_generation), 0) FROM deployments d WHERE d.project_id = p.id
);
