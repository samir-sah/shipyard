# Shipyard implementation plan

## Scope and decisions

Start with one usable public GitHub-to-static-site path. Preserve existing work; this repository was empty when implementation began. Use one npm package for the API, worker, and React dashboard rather than introducing a monorepo framework.

- TypeScript API and worker, React/Vite dashboard.
- PostgreSQL is the source of truth for projects, deployment status, logs, timing, and active artifact selection.
- BullMQ/Redis handles asynchronous scheduling. Stable deployment IDs are job IDs. A dispatcher re-enqueues persisted queued records if initial enqueueing fails.
- Docker runs a fixed root-level Vite recipe on `main`: `npm ci`, then `npm run build -- --base=./`, publishing `dist/`.
- S3-compatible storage holds one artifact prefix per deployment. SeaweedFS replaces MinIO for local development because current MinIO community distribution is source-only and legacy binary images are unmaintained.
- Local path routing `/sites/<slug>/` is the first serving mechanism. Sandbox headers restrict deployed documents while dashboard and site paths share an origin.
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

Basic duplicate protection is present, but is not a claim of complete retry/recovery correctness. The active version is the last successful build to finish. Local paths require relative assets and sandbox-compatible sites. Verification status below determines which behavior was actually exercised.

## Milestone 2 — version selection and rollback

Next incomplete milestone. Add explicit immutable-version manifests and guarded active-pointer updates. Define and test a latest-requested-deployment policy for builds completing out of order. Rollback must choose a fully uploaded previous deployment and invalidate publication from already-running builds according to the documented policy. Test rollback overlapping a build, partial uploads, and failed publication.

## Milestone 3 — recovery and execution safety

Add expiring worker claims, claim renewal, fencing tokens, safe retries, duplicate delivery tests, and worker termination recovery. Prove that stale workers cannot publish after a claim changes. Recover abandoned temporary workspaces/containers and clean incomplete artifact prefixes. Review timeouts, shutdown, queue growth, checkout/dependency disk limits, and host capacity. Keep the Docker socket and platform credentials out of every build container.

## Milestone 4 — integration and operation

Add signed GitHub webhooks and idempotent event handling, separate site origins with host-based routing, project ownership checks, retention preserving active/rollback versions, and a documented deployment procedure. Reassess browser isolation when sites receive separate origins. Add operational monitoring and authentication before exposing the platform beyond local development.

Custom domains, additional build recipes, Kubernetes, and arbitrary backend applications remain deferred. Backend applications need a separate runtime lifecycle design.

## Verification record

Checked November 3, 2026, on Windows with Node.js 22.15.0 and npm 10.9.2:

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

Milestone 1 implementation is present, but full checkout/build/upload/serving evidence remains unverified. Container images, SeaweedFS readiness, real PostgreSQL/S3 integration, and configured Docker resource enforcement still require a working Docker host. No throughput or capacity measurements were collected. Run `docs/DEMO.md` before describing this version as end-to-end verified.

The required later acceptance cases remain: duplicate delivery, worker termination during upload, out-of-order completion, and rollback overlapping a build. Measure queue wait, build duration, throughput, failures, and concurrency on recorded hardware; do not infer capacity from configuration defaults.

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
