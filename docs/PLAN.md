# Shipyard implementation plan

## Scope and decisions

Start with one usable public GitHub-to-static-site path. Preserve existing work; this repository was empty when implementation began. Use one npm package for the API, worker, and React dashboard rather than introducing a monorepo framework.

- TypeScript API and worker, React/Vite dashboard.
- PostgreSQL is the source of truth for projects, deployment status, logs, timing, and active artifact selection.
- BullMQ/Redis handles asynchronous scheduling. Stable deployment IDs are job IDs. A dispatcher re-enqueues persisted queued records if initial enqueueing fails.
- Docker runs a fixed root-level Vite recipe on `main`: `npm ci`, then `npm run build -- --base=./`, publishing `dist/`.
- S3-compatible storage holds immutable files and a completion manifest per deployment. SeaweedFS replaces MinIO for local development because current MinIO community distribution is source-only and legacy binary images are unmaintained.
- PostgreSQL publication generations enforce latest-requested-build ordering and reversible active selection. A superseded successful build remains retained in history.
- Local `/sites/<slug>/` paths redirect to pinned `/versions/<slug>/<deployment-id>/` paths. Sandbox headers restrict deployed documents while dashboard and site paths share an origin.
- Trusted repositories only for the initial demo. Limits reduce accidental resource use; they do not establish safe hostile-code isolation.

## Milestone 1 — first usable slice

Target: public URL → persisted queued deployment → bounded Docker checkout/build → validated S3 artifacts → local serving.

Implementation includes:

- Repository/name input validation and fixed commands passed as argument arrays.
- Persisted queued, building, failed, and deployed states; deployment history and logs.
- React dashboard to create projects, deploy again, inspect history/logs, and open the active site.
- PostgreSQL and Redis development services with durable volumes; S3-compatible SeaweedFS.
- CPU, memory, PID, build-time, artifact-size/file-count, and log-size limits.
- Full output validation before upload, per-version artifact prefixes, and successful-upload checks before activation.
- Failed builds preserve an already active site.
- Separate queue-wait and build-duration timestamps.
- Focused unit/integration checks, Docker setup, architecture diagram, demo procedure, and an unmeasured benchmark template.

Basic duplicate protection is present, but is not a claim of complete retry/recovery correctness. Milestone 2 replaces milestone 1's last-successful-completion ordering. Local paths require relative assets and sandbox-compatible sites. Verification status below determines which behavior was actually exercised.

## Milestone 2 — version selection and rollback

Implementation includes:

- Conditional, non-overwriting artifact writes, actual SHA-256/size verification, and a completion manifest written last.
- An additive migration for project/deployment publication generations and nullable deployment manifests; existing history and active selection remain.
- Project-row locking and guarded active-pointer updates. Deployment creation advances the generation. Only a successful build matching the current generation activates.
- Explicit latest-requested semantics: a newer request suppresses older completions even if that newer request fails. The existing active site remains available.
- Stored-version restore with full object verification before a transaction advances the generation and changes the active pointer.
- Restore supersedes already queued/running builds; they may finish as retained versions. A new request after restore may publish.
- Immutable version URLs and non-cacheable active redirects, so a document and its relative assets remain pinned across publication changes.
- Dashboard version links and restore controls. `deployed` describes a successful retained build; the **LIVE** marker reflects the active pointer.
- Legacy milestone 1 success compatibility: existing serving/history remain; restore verifies and lazily seals old versions without a destructive reset.
- Regression cases for out-of-order completion, newer-request failure, rollback overlapping completion, invalid restore targets, migration preservation, incomplete uploads, immutable writes, and changed/missing objects.
- A CI integration job that starts PostgreSQL/Redis/S3 services, builds platform and builder images, and runs the opt-in integration suite. Adding this job does not establish that a run passed.

The winner is defined by committed PostgreSQL project-row lock ordering, not HTTP arrival time. Before upgrading, stop both API and worker; milestone 1 processes ignore generations and must not overlap milestone 2 processes. See the README upgrade procedure and [migration compatibility](ARCHITECTURE.md#migration-compatibility).

Implementation is present; the verification record distinguishes completed checks from outstanding Docker-backed and browser evidence.

## Milestone 3 — recovery and execution safety

**Next incomplete milestone.** Add expiring worker claims, claim renewal, fencing tokens, safe retries, duplicate delivery tests, and worker termination recovery. Prove that stale workers cannot publish after a claim changes. Project publication generations are not worker-ownership fencing. Recover abandoned temporary workspaces/containers and clean incomplete artifact prefixes. Review timeouts, shutdown, queue growth, checkout/dependency disk limits, and host capacity. Keep the Docker socket and platform credentials out of every build container.

## Milestone 4 — integration and operation

Add signed GitHub webhooks and idempotent event handling, separate site origins with host-based routing, project ownership checks, retention preserving active/rollback versions, and a documented deployment procedure. Reassess browser isolation when sites receive separate origins. Add operational monitoring and authentication before exposing the platform beyond local development.

Custom domains, additional build recipes, Kubernetes, and arbitrary backend applications remain deferred. Backend applications need a separate runtime lifecycle design.

## Verification record

Milestone 1 baseline, checked November 3, 2026, on Windows with Node.js 22.15.0 and npm 10.9.2:

| Command/check | Actual outcome |
| --- | --- |
| `npm install` (exact dependencies and lockfile) | Completed; initial audit reported zero vulnerabilities |
| `npm run typecheck` | Passed for dashboard, backend, demo, and tests |
| `npm test` | 10 passed, 0 failed, 1 skipped: Windows denied creating a symlink |
| `npm run build` | Passed: compiled backend and Vite production dashboard |
| `docker compose config --quiet` | Passed configuration validation |
| `npm run test:integration` | Both tests skipped because `RUN_INTEGRATION` was unset; no integration success claimed |
| Docker Engine / full demo | Blocked: Docker Desktop failed during startup on its `sailor-ingest.sock` listener; engine unavailable |
| Browser visual check | Blocked by automatic approval review because account usage limits prevented browser access |

Milestone 2 local checks actually run during implementation:

| Command/check | Actual outcome |
| --- | --- |
| `npm run typecheck` | Passed dashboard, backend, scripts and test type checking |
| `npm test` | 18 passed, 0 failed, 1 skipped: Windows denied symlink creation; includes 3 dashboard action tests |
| `npm run build` | Passed backend and dashboard production build |
| `docker compose config --quiet` | Passed configuration validation |
| `npm run test:integration` | All 3 top-level suites skipped without `RUN_INTEGRATION`; no local integration success claimed |
| CI integration and runtime smoke | Pending; no result claimed here |
| Browser interaction/visual check | Pending; the prior attempt was blocked by an account usage gate |

Full checkout/build/upload/serving evidence remains unverified in this record. Container images, SeaweedFS readiness, real PostgreSQL/S3 integration, and configured Docker resource enforcement require a working Docker host or a completed CI run. Database concurrency tests and S3 tests are implemented; their presence is not a passing result. No throughput or capacity measurements were collected. Run `docs/DEMO.md` before describing this version as end-to-end verified.

Out-of-order completion and rollback-overlap checks now belong to the milestone 2 integration suite. Duplicate delivery across retry/crash boundaries and worker termination during upload remain milestone 3 evidence. Measure queue wait, build duration, throughput, failures, and concurrency on recorded hardware; do not infer capacity from configuration defaults.

## Dependency decisions and official references

Checked November 2, 2026. Actual npm patch versions are locked in `package-lock.json`; container versions are pinned in the Dockerfiles and Compose file.

| Component | Baseline/reference |
| --- | --- |
| Node.js | [24.22.2 supported LTS release](https://github.com/nodejs/node/releases); Node 26 is now active LTS |
| TypeScript | [Current stable installation guidance](https://www.typescriptlang.org/download/) |
| React | [React 19.3 documentation](https://react.dev/versions) |
| Vite | [Vite 8 and Node 22.12+ requirement](https://vite.dev/blog/announcing-vite8) |
| Express | [Express 5 API](https://expressjs.com/en/api/) |
| PostgreSQL | [Stable 18 release notes](https://www.postgresql.org/docs/release/) |
| pg | [node-postgres package documentation](https://node-postgres.com/) |
| BullMQ | [Connection rules](https://docs.bullmq.io/guide/connections), [production settings](https://docs.bullmq.io/guide/going-to-production) |
| Redis | [Supported versions](https://redis.io/docs/latest/operate/oss_and_stack/install/version-mgmt/) |
| S3 SDK | [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-up.html) |
| SeaweedFS | [Version 4.51](https://github.com/seaweedfs/seaweedfs/releases/tag/4.51), [weed mini configuration](https://github.com/seaweedfs/seaweedfs/wiki/Quick-Start-with-weed-mini) |
| MinIO decision | [Source-only community distribution](https://github.com/minio/minio/blob/master/README.md?plain=1) |
| Docker | [Container limits](https://docs.docker.com/engine/containers/resource_constraints), [Compose service readiness](https://docs.docker.com/compose/how-tos/startup-order) |
