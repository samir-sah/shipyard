# Shipyard implementation plan

## Scope and decisions

Start with one usable public GitHub-to-static-site path. Preserve existing work; this repository was empty when implementation began. Use one npm package for the API, worker, and React dashboard rather than introducing a monorepo framework.

- TypeScript API and worker, React/Vite dashboard.
- PostgreSQL is the source of truth for projects, deployment status, logs, timing, and active artifact selection.
- BullMQ/Redis schedules jobs named `<deployment-id>-<expected-attempt>`. PostgreSQL expected-attempt checks and unexpired lease tokens are authoritative; a dispatcher reconstructs ready queued work.
- Docker runs a fixed root-level Vite recipe on `main`: `npm ci`, then `npm run build -- --base=./`, publishing `dist/`. Retries use the recorded SHA after the first completed Docker build pins it.
- S3-compatible storage holds immutable files and a completion manifest per attempt; the committed database manifest selects a successful version. SeaweedFS replaces MinIO for local development because current MinIO community distribution is source-only and legacy binary images are unmaintained.
- PostgreSQL publication generations enforce latest-requested-build ordering and reversible active selection. A superseded successful build remains retained in history.
- Project subdomains redirect to pinned `/_shipyard/v/<deployment-id>/` paths. Dashboard-host path fallbacks retain opaque-origin sandbox headers.
- Configured operator identities own projects. Host-only signed sessions or bearer access tokens protect management routes; published sites remain public.
- Project-specific signed GitHub deliveries create pinned deployments atomically and idempotently. Optional retention protects active, manually kept and newest successful versions.
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

Implementation includes:

- Persisted UUID claim tokens, 30-second leases, heartbeat renewal every lease/3, and expected-attempt checks. Duplicate/stale deliveries cannot claim or publish through database guards.
- Token/expiry checks on attempt logs, commit pinning, failure transitions, and publication, independently of project publication generations.
- Bounded retries for builder/upload errors and expired claims: three total attempts by default, with exponential backoff starting at one second and capped at 60 seconds.
- Five-second expired-claim recovery and ready-queue reconstruction. Job IDs include the expected attempt, with PostgreSQL remaining authoritative over queue records.
- A `build_attempts` ledger with `building`, `completed`, `failed`, and `expired` states, plus deployment `attemptCount` in API history.
- Git SHA pinning after the first Docker build finishes and before upload. Later attempts fetch the pin; a crash before pinning may still resolve newer `main`.
- Isolated immutable `deployments/<id>/attempts/<token>/` prefixes, completion markers last, and database-selected manifests containing attempt/commit identity. Milestone 1/2 root-prefix reads and rollback remain compatible.
- Unique labeled Docker containers/named volumes and token-prefixed temporary workspaces. Normal cleanup runs even after lease cancellation; cleanup errors do not mask successful upload results.
- Bounded maintenance every 60 seconds for abandoned Docker/local resources and failed/expired attempt objects. Selected and retained successful versions are preserved; retired S3 attempts rotate for repeat cleanup of late obsolete writes.
- Additive migration 003 that preserves completed history/active selection and requeues old building rows after a coordinated API/worker stop. Mixed tokenless old workers are unsupported.
- Tests for duplicate expected attempts, expired/stale fences, retry exhaustion, commit consistency, crash/upload boundaries, and cleanup/resource limits. The crash harness uses real PostgreSQL/S3 and a killed child process with a fake builder; it is not a public Git checkout demonstration.

The existing UI shows attempts through build logs; no separate attempt-history screen was added. No dependencies were added. Full public Git recipe, browser, throughput, and supported-concurrency evidence remain separate verification work. Checkout/npm disk quotas, request growth limits, and hostile-code isolation are not implemented.

## Milestone 4 — integration and operation

Implementation includes:

- Operator-managed identities in `AUTH_USERS`, random access keys generated by `npm run setup`, bearer authentication, and eight-hour HMAC-signed host-only sessions. Token rotation/removal and session-key rotation revoke matching cookies. Signup and SSO were not added.
- Owner-scoped management queries for projects, deployment requests, history, logs, restore, Keep and webhook configuration. Migration 004 assigns existing projects to the fixed bootstrap owner without erasing history or active selection.
- Per-project webhook secrets derived from an API-only master key, project ID and rotating key version. Raw JSON bodies are bounded to 1 MiB and checked with strict HMAC-SHA256 signature handling before delivery acceptance.
- Project/repository/ref validation, pinned push SHAs, atomic delivery/deployment insertion, duplicate replay handling and conflict rejection. The latest accepted project transaction defines order; GitHub head freshness is not inferred from delivery arrival.
- Public project subdomains, pinned version redirects, normal browser origins and version-scoped service workers. Site hosts cannot reach API/session/health routes. Legacy dashboard-host paths keep their opaque sandbox.
- Host routing from the raw Host header; forwarded-host headers do not select projects. Unknown hosts are rejected. Dashboard CSP restricts framing and resource loading.
- Optional age/count retention, disabled by default, with active/manual Keep/newest-version protection. Project-first database locks serialize deletion claims with restore and Keep. Deleting jobs resume after restart; deleted artifacts return 410 while metadata/logs remain.
- Rejection of `.env`, `.env.*` and `.git` artifact paths and existing bounded persisted logs. This is not a detector for secrets embedded in compiled assets.
- A manual dedicated-host deployment procedure covering credentials, HTTPS/DNS/proxy boundaries, health/log monitoring, backups, upgrades and failure handling. An example Nginx config uses operator-supplied certificates; TLS was not provisioned or deployed by these changes.
- Isolated-schema SQL/security/webhook/retention tests, so maintenance test fixtures cannot tombstone existing development projects.

All four implementation milestones are present. Final CI, the public Git-to-Docker smoke and two five-request benchmark bursts passed. Limited local browser session/validation checks also passed. Remaining work is successful project/site browser flows, a real HTTPS/proxy deployment, and sustained capacity measurements. These are not an additional feature milestone. Production reliability and hostile-code isolation remain unproven.

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
| [CI checks on `91378da`](https://github.com/samir-sah/shipyard/actions/runs/41527804763) | Passed: clean install, type checking, 19 tests with no skips, production build, Compose validation |
| CI integration and runtime smoke | Passed: 16 PostgreSQL/S3/HTTP integration tests; both Docker images built; backing services, API and worker started; `/health` returned `{"status":"ok"}` |
| Browser interaction/visual check | Pending; the prior attempt was blocked by an account usage gate |

CI verified image builds, SeaweedFS readiness and conditional writes, actual PostgreSQL concurrency/migration behavior, checksum validation, version serving, rollback rejection of altered artifacts, and API/worker startup. The HTTP suite publishes prepared local artifacts through the storage and selection code; a complete public Git checkout through the Docker builder still needs the `docs/DEMO.md` procedure. Docker resource enforcement and browser interaction remain unverified. No throughput or capacity measurements were collected.

Milestone 3 checks actually run so far:

| Command/check | Actual outcome |
| --- | --- |
| `npx tsx --test test/build.test.ts test/process.test.ts` | 9 passed: process cancellation/timeouts, isolated resource arguments, cleanup after abort/deadline, and cleanup-error handling |
| Server and test TypeScript checks | Passed during build-execution implementation |
| Fixed builder recipe `sh -n` | Passed syntax-only check |
| `npm run typecheck` | Passed dashboard, server, scripts and test type checking |
| `npm test` | 25 passed, 0 failed, 1 skipped because Windows denied symlink creation |
| `npm run build` / `docker compose config --quiet` | Both passed |
| [CI checks on `276bc80`](https://github.com/samir-sah/shipyard/actions/runs/41610083468) | Passed: clean install, type checks, all 26 unit tests, production build and Compose validation |
| Milestone 3 PostgreSQL/Redis/S3/Docker integration | All 32 tests passed with no skips; platform/builder images built and API/worker startup returned healthy |
| Public Git recipe, browser interaction, performance | Not verified by the milestone 3 focused checks |

The passing CI crash tests paused actual S3 upload or completion-marker handling and terminated a child worker with SIGKILL, then verified recovery on a new claim and preservation of the deployment ID. Additional checks verified heartbeat cancellation, stale-token rejection, retry limits, isolated Redis duplicate/retained/lost-job reconciliation, migration preservation, and paginated attempt-only cleanup. Docker checks inspected CPU/memory/swap/PID settings, verified an autonomous timeout, preserved live-claim resources, and removed expired-claim containers, volumes and workspaces. These checks used a prepared fixture builder with real orchestration, PostgreSQL and S3; a full public Git recipe, browser interactions, hostile-code isolation and capacity remain unverified.

Measure first queue wait, deployment elapsed time, per-attempt intervals, retry/recovery delay, throughput, failures, and concurrency on recorded hardware. `buildDurationMs` now includes retry wait and downtime between first claim and terminal completion; it is not a CPU-build measurement. Do not infer capacity from configuration defaults or test durations.

Milestone 4 verification, November 3, 2026:

| Command/check | Actual outcome |
| --- | --- |
| `npm run typecheck` | Passed dashboard, server, scripts and test type checking |
| `npm test` | 36 passed, 0 failed, 1 skipped for Windows symlink privileges |
| `npm run build` | Passed backend and dashboard production build |
| [CI checks on `b3c7cea`](https://github.com/samir-sah/shipyard/actions/runs/41651700848) | Passed: clean install, type checks, all 37 unit tests, production build and Compose validation |
| M4 PostgreSQL/Redis/S3/Docker CI | All 40 integration tests passed without skips; setup generated credentials, both images built, and API/worker startup returned healthy |
| Public Git recipe, browser, production TLS/proxy, performance | Not verified in this snapshot |

CI verified account/project isolation, session boundaries, signed raw-body delivery handling and persistent deduplication, project secret rotation, host routing, protected retention/tombstone recovery, migration preservation, and all earlier crash/retry scenarios. Retention fixtures used random isolated database schemas; other integration fixtures used unique IDs in disposable services. Generated local credentials were also checked absent from 33 build files, and `.env` is ignored by Git. A complete public Git recipe, browser interaction, real HTTPS/reverse-proxy deployment and capacity measurements remain unverified. All four planned implementation milestones are present; these are remaining verification and operational work, not production guarantees.

Public Git-to-site verification, November 3, 2026:

| Command/check | Actual outcome |
| --- | --- |
| Local `npm run typecheck` | Passed, including the new verification runner |
| [CI on `607858b`](https://github.com/samir-sah/shipyard/actions/runs/41685329438) | Passed clean install, type checking, 37 unit tests, production build and Compose validation |
| PostgreSQL/Redis/S3/Docker tests | All 40 passed without skips; API and worker started successfully |
| `npx tsx --env-file=.env scripts/public-demo.ts` | Passed real public Git checkout, npm install, Vite build, S3 publication and both pinned HTTP serving paths |
| Observed result | One attempt; 11.151 ms first queue wait; 16,021.577 ms deployment elapsed; 35 files / 3,282,526 bytes |
| Output verification | Every file size/SHA-256, manifest/commit identity, active selection, static entry references and CSP boundaries passed |

The fixture's actual SHA matched reviewed `cfda8c5841b6e57f644f19aa10c4329553162a15`. [RESULTS.md](RESULTS.md) records environment, cache conditions, configured limits and durable sanitized evidence. This is a single functional smoke, not a capacity measurement. Existing crash/failure/ordering/rollback suites still use their documented deterministic fixtures. Browser execution, DNS/TLS/proxy operation and supported aggregate concurrency remain unchecked.

Benchmark and limited browser verification, November 3, 2026:

| Command/check | Actual outcome |
| --- | --- |
| Local `npm run typecheck` / `npx tsx --test test/benchmark.test.ts` | Passed; two tests cover statistics and claim-overlap boundaries |
| [Manual CI on `5ceed5f`](https://github.com/samir-sah/shipyard/actions/runs/41690912612) | Passed clean install, type checking, 39 unit tests, build, Compose configuration, 40 integration tests, service readiness and real public smoke |
| Benchmark at concurrency 1 | Baseline + warmup + 5/5 measured successes; 2.165 observed completions/minute; no failed/expired attempts or retries |
| Benchmark at concurrency 2 | Baseline + warmup + 5/5 measured successes; 3.874 observed completions/minute; no failed/expired attempts or retries |
| Browser session/validation/outage check | Passed invalid/valid test-key feedback, signed session across reload, invalid repository feedback, project-load error, logout across reload and visual inspection of the narrow default viewport |
| Full successful project/site browser flow | Unavailable locally: Docker Desktop again failed at `sailor-ingest.sock`; temporary auth-only API invocation bypassed startup migrations/readiness and used public test credentials |

[RESULTS.md](RESULTS.md) links durable raw benchmark JSON and browser screenshots, records exact hardware/cache/limits, and separates the two configurations from the earlier single smoke. Each configuration had five measured requests; p95 is its observed maximum. Maximum simultaneous ledger claims were 1 and 2, while peak Docker overlap/CPU/RAM were not measured. Browser tests did not create projects or execute the deployed site's JavaScript. DNS/TLS/proxy operation, sustained capacity and failure-recovery timing remain unverified. Temporary local servers/browser were closed after the manual checks.

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
