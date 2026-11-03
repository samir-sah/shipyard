# Architecture

```mermaid
flowchart LR
  User[Browser] --> Dashboard[React dashboard]
  Dashboard -->|signed session / bearer key| API[Owner-scoped Express API]
  GitHub[GitHub webhook] -->|project HMAC + delivery ID| API
  API --> PG[(PostgreSQL)]
  API --> Queue[(Redis / BullMQ)]
  Queue --> Worker[TypeScript worker]
  Worker --> PG
  Worker --> Builder[Bounded Docker build]
  Git[Public GitHub main branch] --> Builder
  Builder --> Validate[Validate dist tree]
  Validate --> S3[(Immutable S3 files + completion manifest)]
  Worker -->|guarded activation after validation| PG
  User -->|project site host| API
  API -->|active version| PG
  API -->|302 to pinned version URL| User
  User -->|/_shipyard/v/id/| API
  API -->|read version objects| S3
  Worker -->|guarded retention claims| PG
  Worker -->|delete claimed obsolete versions| S3
```

## Deployment lifecycle

1. The API authenticates a configured identity, validates a project name/public HTTPS GitHub URL, and persists its owner. Every management route scopes projects to that owner. Repository credentials, arbitrary build commands, branch names, and output paths are not user inputs.
2. PostgreSQL locks the project row, advances its publication generation, and creates a stable deployment ID in `queued` state with that generation. BullMQ jobs use `<deployment-id>-<expected-attempt>`. A dispatcher reconstructs ready queued work from PostgreSQL when scheduling did not complete.
3. A worker atomically claims the matching expected attempt as `building`, creates a UUID token, and records an expiring lease and a `build_attempts` row. Duplicate or stale deliveries cannot bypass the database's expected-attempt, status, retry-time, and attempt-limit checks.
4. The worker creates a token-specific Docker container and named `/work` volume with management labels and fixed image/commands. Checkout and build run inside that container. Platform database/S3 credentials and the Docker socket are not passed to it.
5. After the Docker build finishes and output is copied, the current lease holder records the Git SHA before upload. Webhook deployments already have their verified payload SHA pinned at creation. The worker validates `dist`, requires `index.html`, rejects unsupported entries, secret-looking paths and the reserved manifest name, and enforces file-count and byte limits. Files go under `deployments/<deployment-id>/attempts/<token>/` with conditional `If-None-Match: *` writes. The worker reads each uploaded object back and checks its actual byte length and SHA-256.
6. After every file passes, the worker writes `__shipyard_manifest.json` last, also without overwrite. New manifests contain `attemptId` and `commitSha` in addition to the deployment ID, file keys, sizes, SHA-256 values, and total bytes. A partial prefix without this marker is not a complete new version.
7. After normal build-resource cleanup, a transaction locks the project and deployment, checks the current unexpired claim token and pinned commit, changes the deployment from `building` to `deployed`, and stores the selected attempt's manifest. It changes the active pointer only if the project's generation still matches. A superseded successful build remains retained. A failed attempt preserves the pointer and either queues a bounded retry or ends the deployment as `failed`.
8. The active site route selects a deployment once and redirects to its immutable version path. Subsequent relative asset requests stay pinned to that version even when the active pointer changes.

`queueWaitMs` covers creation to the **first** claim. The API's `buildDurationMs` field covers first claim to final deployment completion, including checkout/install, validation/upload, cleanup, retry backoff, later queue waits, and downtime after a worker crash. Treat this as deployment elapsed time after the first claim, not pure build execution or CPU time. Per-attempt timestamps in `build_attempts` provide a separate operational timeline.

## Worker leases, retries, and cleanup

The default lease is `WORKER_LEASE_MS=30000`; a heartbeat renews it every third of that interval. PostgreSQL's clock and row locks decide whether a claim remains valid. Renewal, attempt logs, commit pinning, failure transitions, and final publication require the matching token and an unexpired lease. An expired or replaced worker cannot renew itself or publish. The worker combines lease cancellation with the per-attempt build deadline and passes that signal through Docker execution and artifact upload.

The build container runs the fixed recipe through `/usr/bin/timeout --signal=TERM --kill-after=10s`, with the configured build duration. This autonomous deadline survives worker termination. The host deadline additionally covers resource creation, output copy, and upload. An expired container can overlap a replacement until its own deadline or janitor cleanup; per-worker job concurrency does not impose a strict global container or machine-capacity limit.

Every five seconds the worker recovers up to 100 expired claims and dispatches ready queued work. An expired attempt becomes `expired`; a builder/upload failure becomes `failed`. Deployments below `MAX_BUILD_ATTEMPTS=3` return to `queued`; the final exhausted attempt makes the deployment terminally `failed`. Retry backoff is `min(60, 2^(attempt - 1))` seconds. All builder and upload errors use this bounded policy, including errors that are deterministic.

`build_attempts` records stable token/number pairs with `building`, `completed`, `failed`, or `expired` state. Deployment API responses expose `attemptCount`; the existing dashboard logs identify attempts without a new attempt-history interface. BullMQ keeps its own job records, but those records are not ownership authority. The dispatcher can remove a completed/failed matching job record when PostgreSQL still requires that expected attempt. Database checks remain effective if a duplicate delivery bypasses queue deduplication.

The Git SHA is pinned when a Docker build first finishes and the worker records its result, before the first upload. Subsequent attempts fetch that exact SHA and reject a different result. A crash before this pin is recorded may cause the next attempt to resolve a newer `main`; the platform does not claim submission-time commit snapshots.

Each attempt owns `shipyard-<deployment-id>-<token>`, `shipyard-work-<token>`, and a `<token>-*` directory beneath the worker's `shipyard-builds` temporary root. Docker resources carry `shipyard.managed=true`, `shipyard.claim=<token>`, and `shipyard.deployment=<id>` labels. Cleanup commands run independently of a canceled lease, so cancellation does not prevent removing the container, volume, and workspace. Cleanup errors are logged rather than masking a completed upload result.

On startup and every 60 seconds, maintenance inspects bounded batches: at most 100 labeled containers, 100 labeled volumes, 100 local temporary directories, and 10 failed/expired artifact attempts per pass. Current live claims are preserved. S3 cleanup excludes the attempt selected by the deployment's committed manifest; it never deletes completed retained versions. Failed/expired attempts rotate by their last cleanup time, become eligible again after 60 seconds, and can be revisited to remove late writes from an obsolete process.

Cleanup is eventual and best effort, with no fixed completion deadline under backlog or infrastructure failure. A worker can inspect its Docker daemon's labeled resources, but cannot delete another host's local temporary directory. Pre-milestone-3 unlabeled resources need separate operator review. Successful-version retention uses the separate guarded state machine below.

## Publication ordering and rollback

The policy is **latest requested build**, not latest successful completion. Deployment creation advances the project generation immediately. If A starts, B is requested, and B fails, a later successful completion of A is retained but cannot replace the existing active site. This avoids publishing an earlier request after the operator has requested a newer one.

Restore accepts only a `deployed`, artifact-`available` version belonging to the owned project. Before changing database state, it compares the completion manifest with the manifest saved in PostgreSQL and rechecks every listed object's actual SHA-256 and size. A changed marker, missing object, corrupt object, or invalid manifest rejects restore without changing the active selection. The transaction checks availability again, so retention cannot race a target back into use. Legacy milestone 1 versions have an explicit compatibility path below.

Once validation succeeds, the rollback transaction locks the project row, checks the target again, advances the project generation, and updates the active pointer. Earlier queued or running builds may finish, upload, and remain in history, but their older generations cannot publish. A deployment requested after rollback receives a newer generation and may publish normally.

Deployment creation, activation, and rollback serialize through the same PostgreSQL project-row lock. The committed database order defines which action wins. HTTP arrival time or the time a rollback starts object validation does not define that order. A completion racing with rollback either becomes active first and is then replaced, or observes rollback's newer generation and remains retained.

## Persistence boundaries

PostgreSQL is authoritative. Redis AOF retains queue data, but the queue is not the deployment-history database. Object storage is separate from both. Named volumes persist all three local services. Artifact retention is optional; backups and consistent recovery remain operator responsibilities.

Per-attempt immutable prefixes and a completion marker prevent an incomplete or obsolete attempt from becoming a served version. PostgreSQL's committed manifest selects the attempt prefix used for reads and rollback. Older manifests without an `attemptId` continue to select the legacy `deployments/<deployment-id>/` root. The database manifest is recorded only after the marker exists. This is a publication boundary, not a transaction spanning PostgreSQL and S3: a crash can leave complete or partial unused objects before database completion.

Generation checks guard project action order. Claim tokens and leases independently fence worker ownership. A stale process can leave objects in its own obsolete prefix, but cannot choose that prefix as the successful version after claim loss. A crash can leave resources until lease recovery and maintenance run. Do not manually republish a partial prefix or reset claim fields while a worker may still run.

## Migration compatibility

Migration `002_version_selection.sql` adds generation columns and a nullable deployment manifest. It orders existing deployments by creation time and ID for the generation backfill, without replacing deployment IDs, history, logs, or active pointers. Startup migrations run under a PostgreSQL advisory transaction lock.

Migration `003_worker_claims.sql` adds claim/expiry/retry fields, attempt counts, and `build_attempts`. After both old application processes have stopped, old `building` rows are requeued with an upgrade note. Existing completed history, active pointers, and root-prefix manifests are preserved. No old tokenless process may overlap the new worker.

Migration `004_ownership_webhooks_retention.sql` adds immutable-by-API project ownership, webhook configuration/delivery metadata, and artifact retention state. Existing projects receive owner ID `00000000-0000-4000-8000-000000000001`, matching setup's bootstrap identity. Existing artifacts default to available/unkept; disabled retention creates no deletion claims. Existing history, manifests, IDs and active pointers remain.

| Existing data | Current behavior |
| --- | --- |
| Project and deployment history | Preserved; no destructive reset |
| Active deployment pointer | Preserved, including serving its existing version |
| Successful version without a manifest | Remains accessible as a legacy version; restore verifies and seals it lazily |
| Legacy `NULL` database manifest | Backfilled only when that successful version is restored |
| Milestone 2 root-prefix manifest | Read and rollback continue using the root prefix |
| Old `building` deployment after coordinated stop | Requeued by migration 003; history and first-start timestamp retained |
| Newly completed milestone 3 deployment | Reads the selected token prefix in its committed manifest |
| Project predating ownership | Assigned to the configured bootstrap owner by migration 004 |
| Successful version predating retention | Available by default; age/count deletion stays disabled until configured |
| Missing legacy index or altered remaining legacy objects | Restore rejected; active pointer and generation unchanged |
| Additive columns after application downgrade | Left intact; no automatic database downgrade |

Legacy serving is restricted to already persisted successful deployments. It is not a way to publish an unfinished new upload. For restore, the compatibility path lists the old prefix, validates required `index.html`, bounds its file count and size, and reads its objects. Each object's actual SHA-256 must match the metadata recorded by milestone 1. It then creates the completion marker and records the manifest during rollback. The reserved marker file is not exposed as a site artifact.

Milestone 1 stored no complete file list. Legacy discovery cannot detect an asset deleted before discovery when the index and remaining objects still validate. Rebuild a legacy version to obtain the full milestone 2 completeness guarantee.

**Coordinated application stop is required.** Stop both API and worker, wait for graceful worker shutdown, update and build the code/images, then start both new processes. Keep backing services and volumes. Older API/worker code does not honor the current generation/token/attempt-prefix rules and must not run alongside milestone 3. The README contains the upgrade commands.

An application downgrade is not transparent: milestone 1/2 readers cannot locate new attempt-prefix artifacts from a milestone 3 manifest. Stop both application processes and plan artifact compatibility or backup recovery before considering old code. Keep additive columns; there is no automatic schema reversal. Do not mix tokenless older workers with the new application.

## Build threat model

This platform accepts configured operators and trusted repositories. A public repository is not inherently trustworthy. `npm ci` can execute install scripts, and `npm run build` executes repository code. Operator authentication does not make submitted code safe.

Default per-attempt limits are 1 CPU, 512 MiB memory, 128 PIDs, and 300 seconds for resource creation, checkout, build, output copy, and upload, with worker concurrency 1. Lease cancellation or the deadline aborts Docker CLI and upload work. Synchronous/local validation and final cleanup can extend total attempt wall time, and retry waits/downtime extend total deployment time. Output limits are 64 MiB and 5,000 files; persisted logs are capped at 1 MiB per deployment across attempts. Verify Docker's host-kernel resource support before relying on configured bounds. No measured capacity is implied.

Build containers receive no platform secrets or Docker socket. The worker needs the Docker socket to create them and therefore has privileged control over the Docker host. Run this platform on a dedicated development host. Builds can access the network; there is no hostile-code network isolation, VM boundary, checkout-size quota, or dependency disk quota. Deployment requests can grow the database/queue without a submission quota. Container resource limits alone do not prove a secure sandbox.

Compose exposes development ports only on loopback. Management routes require authentication and ownership, but a manually exposed installation still needs HTTPS, separate site domains, restricted infrastructure access and monitoring. API authentication/webhook master keys are not passed to the worker or build containers. `.env`, `.env.*` and `.git` artifact paths are rejected; arbitrary secrets in compiled JavaScript or log text cannot be reliably detected. See [deployment](DEPLOYMENT.md).

## Browser serving boundary

`SITE_BASE_URL=http://sites.localhost:3000` produces `http://<slug>.sites.localhost:3000/`. Host routing uses the raw `Host` header and ignores `X-Forwarded-Host`. A project host rewrites only static-site paths internally; API, session and health endpoints are unreachable there, and non-read requests are rejected. Unknown hosts return 404. The root responds with a non-cacheable redirect to `/_shipyard/v/<deployment-id>/`. Relative assets stay pinned across active-pointer changes.

Project hosts have normal origins, distinct from the dashboard and other projects. Versions within one project share that origin and local storage. Service workers can register under their version path; no header grants broader scope. For public operation, use HTTPS and a site base on a different registrable domain from the dashboard, with a reverse proxy preserving `Host`.

Dashboard-host `/sites/<slug>/` still redirects to `/versions/<slug>/<id>/` as a local fallback. Those shared-host documents retain an opaque-origin CSP sandbox without `allow-same-origin`; cookies, local storage and service workers are unavailable. Anonymous CORS permits their module assets to load. The dashboard has its own CSP, including frame-ancestor restrictions.

Repositories must emit relative assets. Extensionless version paths fall back to `index.html`; missing extension-bearing paths return 404. History routers need the version basename and correctly resolved assets; hash routing is simplest. Deleting/deleted version artifacts return 410 on either serving route. Published sites are intentionally public, including pinned versions until retention expires them.

## Authentication and ownership

`AUTH_USERS` supplies UUID/name/access-token entries from private operator configuration. Tokens are random bearer secrets, not human passwords. There is no signup, password reset, SSO, user database or ownership-transfer UI. Setup generates the bootstrap identity and missing secrets while preserving existing nonempty values.

Browser login exchanges the access token for an eight-hour HMAC-signed session containing identity, expiry and a token-derived key ID. Cookies are HttpOnly, SameSite=Strict and host-only. HTTPS dashboard configuration selects a Secure `__Host-shipyard_session` cookie; localhost development HTTP uses `shipyard_session`. Verification checks the current configured user/token as well as the session signature, so token rotation, removal or a global session-key change revokes sessions after API restart. Programmatic clients use the bearer token directly.

Owner checks protect project listing, build creation, logs/history, restore, Keep and webhook setup. Cross-origin mutations and non-JSON management writes are rejected. Webhook ingress uses its independent raw-body signature boundary. Published artifacts are not an authenticated file-sharing mechanism.

## Signed deliveries

The API derives a project secret using `GITHUB_WEBHOOK_KEY`, project ID and monotonically increasing webhook key version. Enable/rotate/disable updates configuration under the project lock. Only the owning identity can configure it; the derived secret is returned at that action, not in project listings. The API-only master key is never shared with GitHub or build containers.

Ingress accepts at most 1 MiB of raw JSON, verifies `X-Hub-Signature-256` with a timing-safe HMAC comparison, then validates repository identity and push fields. A live `refs/heads/main` push pins its `after` SHA. Ping, other branches and deleted refs record accepted deliveries without scheduling a build. See GitHub's [signature guidance](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

`webhook_deliveries` has a project/delivery-ID primary key. Under the project lock, acceptance rechecks enabled/key-version state, rejects conflicting body hash/event reuse, and atomically inserts the delivery plus any queued deployment and generation increment. Duplicate delivery returns its original deployment. Queue enqueueing is recoverable from PostgreSQL. Rotation racing acceptance is ordered by that lock. This is idempotence, not a guarantee that arrival order matches GitHub commit chronology: a late older push accepted later receives the newer publication generation.

## Successful-version retention

`RETENTION_DAYS=0` disables new deletion claims. Positive values permit only successful available versions older than that age, excluding the active pointer, manual Keep flag and `RETENTION_KEEP` newest successful versions by finish time/ID. The keep count defaults to five and must be at least one. Build history and log records are retained.

A bounded claim transaction locks the project before the target deployment and rechecks eligibility, then marks it `deleting`. Restore and Keep use the same lock order and require `available`, preventing deletion/restore races. Storage work happens after the transaction: the worker deletes only that deployment prefix and marks it `deleted` on success. Already claimed deletion jobs resume even when new retention is disabled; the claim has passed the point where preservation can be promised. Failed storage deletion leaves a tombstone to retry.

There is no undelete operation or automatic backup restoration. A worker crash between object deletion and the final database update can leave `deleting` until an idempotent retry finishes. Operators must protect rollback versions with Keep before they become eligible and maintain separate backups. Integration retention operations use isolated schemas so development projects are not deletion fixtures.
