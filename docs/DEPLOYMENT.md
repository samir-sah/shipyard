# Deployment and operation

This is a manual procedure for a dedicated, operator-managed host running trusted builds. The repository does not provision DNS, certificates, remote machines or backups. No public production deployment or production reliability claim is recorded here. Development Compose remains bound to loopback.

## Local bootstrap and upgrade

Install supported Node.js, Linux Docker Engine/Desktop and Compose v2. From the repository root:

```sh
npm run setup
docker compose --profile tools build
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 api worker
```

Setup uses Node's standard library, creates `.env` from the example when absent, generates missing credentials and preserves existing nonempty values. It requests mode 0600 on new writes; apply suitable account/ACL restrictions on your host, especially Windows. `.env` is ignored by Git. Do not paste its keys into issues, screenshots, build output or repository files.

For upgrades, back up first and stop **both** API and worker. Let the worker finish within Compose's six-minute grace or investigate a forced stop. Keep PostgreSQL/Redis/S3 volumes:

```sh
docker compose stop api worker
git pull --ff-only
npm run setup
docker compose --profile tools build
docker compose up -d api worker
```

Migrations run under an advisory transaction lock and are additive. Existing IDs/history/active selection remain. Migration 003 requeues old unclaimed builds; migration 004 assigns old projects to the bootstrap identity. Old/new application versions must not overlap. Older readers cannot interpret all new attempt prefixes, ownership or retention state, so checking out older code is not a safe downgrade. Use a tested backup/compatibility plan before any downgrade.

## Accounts and secret rotation

`AUTH_USERS` is a single-line JSON array of `{id,name,token}` entries. IDs are UUIDs; names contain 1–80 characters; tokens contain 32–128 ASCII letters/digits/underscore/hyphen. Generate at least 32 random bytes per token. Setup's 64-character hex keys meet that requirement.

The first generated identity uses `00000000-0000-4000-8000-000000000001`, the fixed owner assigned to legacy projects. Preserve that ID in configuration if its operator should retain access to them. New projects belong to the signed-in identity. There is no signup, SSO, ownership-transfer UI or user table.

Generate a new entry privately, merge it into `.env`'s existing array, and recreate the API. This command prints a fresh secret; keep the output private:

```sh
node --input-type=module -e "import {randomUUID,randomBytes} from 'node:crypto'; console.log(JSON.stringify({id:randomUUID(),name:'Operator 2',token:randomBytes(32).toString('hex')}))"
docker compose up -d --force-recreate api
```

Do not replace the entire array when intending to add one identity. Removing an identity makes its management resources inaccessible through the API; it does not delete published sites or data. Published artifacts are public regardless of operator sessions.

Browser login creates an eight-hour signed session. Cookies are HttpOnly, SameSite=Strict, host-only and path `/`. HTTPS `DASHBOARD_ORIGIN` selects a Secure `__Host-shipyard_session` cookie; HTTP localhost development uses `shipyard_session`. Session verification also checks the identity's current access-token hash. Replacing that token or removing its identity revokes its sessions after API restart; rotating `SESSION_SECRET` revokes all sessions. API clients use `Authorization: Bearer <operator-token>` directly.

`SESSION_SECRET` and `GITHUB_WEBHOOK_KEY` require at least 32 bytes; use independent random values. The latter derives project/version-specific webhook secrets, and only the derived project secret is configured in GitHub. A master-key rotation invalidates every configured GitHub secret; enable/rotate each affected project, copy its current derived secret to GitHub, and verify delivery again. Project-level rotation/disable increments its stored key version. The master key and auth/session values are API-only in Compose; the worker and build containers do not receive them.

## HTTPS, DNS and reverse proxy

Choose separate registrable domains for dashboard and untrusted published sites, for example:

```dotenv
DASHBOARD_ORIGIN=https://shipyard.example.com
SITE_BASE_URL=https://sites.example.net
```

Configure dashboard DNS and wildcard DNS for `*.sites.example.net` to the proxy. Supply certificates for the dashboard name and wildcard site names. `SITE_BASE_URL` itself is a base for project subdomains; it is not a dashboard route. These `.example` names are placeholders, not deployed addresses.

Use [the Nginx example](../deploy/nginx.conf.example) as a starting point on a host that already has certificates. Replace names, certificate paths and upstream port. Keep the API's port on loopback and expose only the proxy's intended HTTPS listener. PostgreSQL, Redis, S3 and the Docker socket must not be exposed to clients.

The proxy must preserve the actual requested `Host`; Shipyard ignores forwarded-host routing headers and does not enable Express `trust proxy`. HTTPS cookie selection comes from `DASHBOARD_ORIGIN`, so set it to the real external HTTPS origin before starting the API. Unknown hosts are rejected. Nginx's [proxy header documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header) explains the upstream Host default that the example overrides.

Validate your changed proxy config with `nginx -t`, then check the dashboard login, both origin boundaries, a published page, relative assets, restore and a signed delivery over HTTPS. Test that a project host cannot return `/api/session` or `/health`, and that its requests cannot read another project's management resources. The checked-in example has not been deployed or validated against your certificates/network.

The default `*.sites.localhost` setup is for local HTTP development. Normal project origins support local storage and version-scoped service workers; versions of a project share its origin. Dashboard-host fallback pages remain opaque-sandboxed. Do not place platform credentials in a published site or broaden service-worker scope to the dashboard.

## GitHub ingress

Enable a project's webhook from its owning dashboard session and copy the returned URL/secret to that GitHub repository. Select JSON and push events. GitHub must reach the dashboard's HTTPS endpoint; localhost requires separate forwarding setup. Follow GitHub's [delivery-handling guide](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries).

The API accepts a bounded raw body, verifies HMAC-SHA256 before parsing, checks the repository/ref, and records each delivery atomically with any deployment. Only a non-deleted `main` push creates a deployment, pinned to its supplied SHA. Other valid event/ref cases record no build. Duplicate IDs reuse their first result; changed bytes/event for that ID return 409. Rotation racing acceptance is fenced by the project key version.

The service does not poll GitHub head or sort deliveries by commit chronology. The last accepted project transaction gets the newer publication generation, even if its payload describes an older push. Inspect GitHub delivery results and Shipyard's deployment history when diagnosing late arrivals. Do not log signing secrets or raw bearer headers.

## Monitoring and backups

`GET /health` on the dashboard host checks PostgreSQL, Redis and the S3 bucket. It does not prove an idle worker exists, Docker can build a repository, or a queue is making progress. Check worker process/logs, deployment age and lease/attempt history separately:

```sh
docker compose ps
docker compose logs --tail=200 api worker
docker stats --no-stream
docker compose exec postgres psql -U shipyard -d shipyard
```

Useful read-only SQL:

```sql
SELECT status, count(*), min(created_at) AS oldest FROM deployments GROUP BY status;
SELECT count(*) AS expired_claims FROM deployments
  WHERE status = 'building' AND lease_expires_at <= clock_timestamp();
SELECT status, count(*) FROM build_attempts GROUP BY status;
SELECT artifact_state, count(*) FROM deployments GROUP BY artifact_state;
```

Alert on sustained queued age, expired claims that remain unrecovered, failed attempts, failed health checks, disk/memory exhaustion and repeatedly failing cleanup. No external metrics/alerting backend is installed. Logs are capped per deployment but may contain repository-generated sensitive text; owner checks do not sanitize arbitrary log contents.

Back up PostgreSQL metadata, Redis persistence, S3 contents and the private `.env` as a consistent recovery set. Stop application writers for a maintenance checkpoint, use backend-supported backup/snapshot methods, and record the application commit and schema versions. Do not copy live changing Redis/S3 files and assume they form an atomic backup. PostgreSQL documents [logical dumps and restore](https://www.postgresql.org/docs/current/backup-dump.html). Keep encrypted/private backups outside the checkout and verify restoration on a separate host/volumes before relying on them.

Restoring only PostgreSQL can select missing artifacts; restoring only S3 can leave metadata absent. Redis is scheduling data, while PostgreSQL remains authoritative for queued work. Preserve matching manifests and data, restart the matching application version, and validate active pages, history and claim recovery before reopening ingress. No transaction spans all backing services, and this repository does not implement automated disaster recovery.

## Retention and failure handling

Leave `RETENTION_DAYS=0` to preserve successful artifacts indefinitely unless deliberately operating retention. A positive integer age enables new claims; `RETENTION_KEEP` is a positive newest-success count, default five. Active versions, manual Keep flags and that newest group are protected independently. Review backups and mark required rollback versions Keep before enabling a purge.

The worker claims eligible old versions by changing `available` to `deleting`, then deletes their deployment prefixes and finishes `deleted`. Restore and Keep reject unavailable targets under the project lock. Version reads return 410; history/logs remain. Already deleting jobs continue even after setting the age back to zero, because object deletion may already have started. There is no undelete endpoint.

If storage deletion fails, retain its tombstone and repair storage access; maintenance retries. Do not reset `artifact_state` to available after a partial delete. If restore reports 409, investigate missing/changed objects and storage health rather than bypassing manifests. Recover a consistent backup or rebuild a new deployment when artifacts are lost.

If a worker disappears, restore infrastructure/worker access and allow lease recovery plus backoff. Do not copy old claim tokens, reset attempt counts, or manually activate partial prefixes. A lower attempt budget closes already exhausted queued retries. Old unlabeled Docker resources require operator review; the automatic janitor acts only on managed labels and token-shaped workspaces.

Auth, ownership and signatures do not provide hostile-code isolation, quotas or measured capacity. Builds retain network access and can consume unbounded checkout/npm disk space; the worker controls the Docker host. Use a dedicated host, trusted repositories, recorded capacity limits and tested backups. Retention fixtures use isolated random schemas; run other fixtures against disposable services. Do not manufacture retention evidence by deleting real development projects.
