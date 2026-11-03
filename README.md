# Shipyard

Shipyard turns a supported public GitHub repository into a static site on its own subdomain. Sign in, submit a repository, follow its build logs, and restore a completed version without rebuilding it.

All four planned implementation milestones are present: TypeScript API/workers, React dashboard, PostgreSQL metadata, BullMQ/Redis scheduling, bounded Docker builds, immutable S3 artifacts, rollback, worker recovery, ownership, signed webhooks, host routing, and retention. SeaweedFS supplies S3-compatible local storage. [The verification record](docs/PLAN.md#verification-record) covers public Git builds, small benchmark bursts, a private-CA HTTPS proxy smoke and limited browser checks, with remaining limits stated explicitly.

## Run locally

Requires Node.js 22.12+ and Docker Engine with Linux containers and Compose v2. Node.js 24 LTS is recommended. On Windows/macOS, start Docker Desktop first. A small demo should start with at least 2 CPUs, 4 GiB RAM, and 5 GiB free disk; these are recommendations, not measured capacity.

Check free space on Docker's data drive as well as the checkout drive before pulling/building images. On Windows, Docker's virtual disk can be on `C:` even when this repository is on another drive. `Get-PSDrive -PSProvider FileSystem | Select-Object Name,Free` reports host-drive free bytes; Docker's internal free-space figure alone does not establish room for its backing virtual disk to grow.

```sh
git clone https://github.com/samir-sah/shipyard.git
cd shipyard
npm run setup
docker compose --profile tools build
docker compose up -d --build
docker compose logs -f api worker
```

Setup creates a private, ignored `.env`, generates missing access/session/webhook keys, and preserves existing nonempty credentials. Open [the dashboard](http://localhost:3000). Sign in with the operator token from `AUTH_USERS` in your local `.env`. Keep that file and token private. Existing projects belong to the bootstrap operator ID described in [deployment and accounts](docs/DEPLOYMENT.md#accounts-and-secret-rotation).

Compose publishes development services only on loopback. Named volumes preserve PostgreSQL, Redis, and artifacts. The `builder` service is an image target under the `tools` profile; the worker creates its own bounded container and volume for each attempt. Stop services with `docker compose down`. Adding `-v` deletes persistent volumes, including deployment history and published sites.

## Supported repository recipe

| Setting | Supported value |
| --- | --- |
| Source | Public `https://github.com/owner/repo.git` URL |
| Branch / directory | `main`, repository root |
| Lockfile | Committed root `package-lock.json` |
| Install | `npm ci` |
| Build | `npm run build -- --base=./` |
| Output | `dist/`, containing `index.html` |
| Builder runtime | Node.js 24 |
| Default site | `http://<project-slug>.sites.localhost:3000/` |
| Pinned version | `http://<project-slug>.sites.localhost:3000/_shipyard/v/<deployment-id>/` |

Use repositories you trust: install/build scripts execute code and have network access. The build script must accept Vite's `--base=./`; emitted asset paths must be relative. Hash routing is the easiest choice. History routers need a matching version basename, and nested routes need correctly resolved relative assets. Shipyard itself produces `dist/dashboard`, so this repository is not a fixture for that recipe.

The project host redirects to a pinned version URL. Its document and relative assets stay on that version during later publication or rollback. Project hosts have normal browser origins: local storage and version-scoped service workers can work. Projects have separate hosts; versions of one project share its origin. When local DNS does not resolve `*.sites.localhost`, the dashboard-host `/sites/<slug>/` fallback still works with an opaque-origin CSP sandbox; cookies, local storage, and service workers are unavailable there.

Published artifacts are public. Project hosts never expose dashboard API, session, or health routes. Ownership controls the management API and dashboard, including deployment submission, history, logs, rollback, Keep, and webhook configuration.

## Publication, rollback, and recovery

Creating a deployment advances the project's publication generation. **Latest requested build wins**: a successful build activates only while its generation remains current. An older completion cannot replace the active site after a newer request, even if that newer request fails. Superseded successful versions remain in history.

The worker validates the output, uploads immutable files, reads them back to verify size/SHA-256, then writes the completion manifest. Only afterward can a guarded PostgreSQL transaction select the version. Failed builds preserve the active site. **Restore** verifies the target's saved manifest and every stored object, advances the project generation, and switches the pointer. Earlier queued/running builds cannot undo the restore; a later request can publish normally.

Each attempt has a persisted UUID token, a default 30-second lease renewed every 10 seconds, its own Docker resources/workspace/artifact prefix, and an expected-attempt job ID. PostgreSQL fences stale renewal, logs, commit pinning, failure, and publication. A five-second scan reconstructs queued work and recovers expired claims. Failures retry up to three total attempts by default, using exponential backoff capped at 60 seconds. Lowering the attempt limit also closes exhausted queued retries.

Manual builds pin their Git SHA after the first completed Docker build, before upload; a crash before that pin may resolve newer `main`. A verified push webhook pins its payload SHA when the deployment is created. Containers enforce their own deadline even if their worker disappears. Maintenance revisits abandoned resources every 60 seconds. Per-worker concurrency is not a strict machine-wide container cap, and cleanup is bounded and best effort. [Architecture and threat model](docs/ARCHITECTURE.md) explains these limits.

`queueWaitMs` measures creation to first claim. The API's historical field `buildDurationMs` measures elapsed time after that claim, including retry backoff, later queue waits, validation/upload, and worker downtime; it is not pure Docker build time. Per-attempt timestamps provide a separate operational timeline.

## Webhooks and retention

Enable a project's GitHub webhook in the dashboard and copy the returned URL and secret into that repository's webhook settings using JSON payloads. Each enable/rotate action produces a new project-scoped secret; update GitHub after rotation. Disable invalidates the old secret. The API validates the raw payload signature, repository, `main` ref, and commit before atomically recording its delivery and queued deployment. Repeated delivery IDs reuse the original result; conflicting payloads return `409`. Other branches/deletions do not create deployments. Latest accepted database order governs publication; webhook arrival order does not prove which commit is the newest GitHub head. See [the webhook demo](docs/DEMO.md#signed-github-webhook).

Retention defaults to `RETENTION_DAYS=0`, which disables new deletion claims. With a positive age, it can delete old successful artifacts outside `RETENTION_KEEP=5` newest successful versions per project. Active versions and versions marked **Keep** are protected independently. A deletion claim changes `artifactState` from `available` to `deleting` under the same project lock used by restore/Keep. Such jobs resume after a crash, even if new retention is then disabled, and finish as `deleted`. Expired version URLs return `410`; history and logs remain. Keep does not delete anything, and deleted artifacts cannot be undeleted through Shipyard.

## Development and checks

```sh
npm ci
npm run setup
docker compose --profile tools build builder
docker compose up -d --wait postgres redis storage
npm run dev:api
# Separate terminals:
npm run dev:worker
npm run dev:dashboard
```

Host scripts load `.env`; keep `DATABASE_URL` consistent with its PostgreSQL password. Compose supplies internal service URLs and passes authentication/webhook master keys only to the API. The Vite server proxies local API/site/version paths to port 3000.

```sh
npm run typecheck
npm test
npm run build
docker compose config --quiet
RUN_INTEGRATION=1 RUN_DOCKER_TESTS=1 npm run test:integration
```

In PowerShell, set `$env:RUN_INTEGRATION='1'` and `$env:RUN_DOCKER_TESTS='1'` before the last command. Integration tests require running backing services; Docker cases also require the builder image and a Linux daemon. Retention/ownership maintenance suites use isolated random PostgreSQL schemas. Other suites use unique fixture IDs in the configured database; run them against disposable development services. Never infer a passing integration run from an unset flag and skipped tests.

The [demo guide](docs/DEMO.md) covers successful/failed deployments, rollback, crashes, ownership, webhook redelivery, and retention. The helper requires `SHIPYARD_TOKEN` set explicitly to an operator access token. CI also runs a reviewed public Vite repository through the real Docker build and verifies every served artifact. Manual CI dispatch adds two five-request benchmark bursts at worker concurrency 1 and 2. [Recorded results](docs/RESULTS.md) include raw timing, machine limits and limited browser checks; [sustained capacity](docs/BENCHMARK.md) remains unmeasured.

## Upgrade and operation

Stop both API and worker, back up PostgreSQL/Redis/S3 plus `.env`, update the checkout, run `npm run setup` to add missing keys, rebuild both images, and restart matching application versions. Additive migrations preserve IDs, history, manifests, and active selection; migration 004 assigns existing projects to the fixed bootstrap owner. Migration 003 requeues old unclaimed builds. Mixed old/new workers and automatic downgrades are unsupported. See [the deployment procedure](docs/DEPLOYMENT.md) before exposing the API beyond localhost.

HTTPS and a separate registrable site domain are recommended for a manually operated dedicated host. TLS, DNS, backups, and reverse-proxy setup remain operator work; no external deployment was performed here. Signup, SSO, ownership transfer, custom domains, Kubernetes, additional recipes, and arbitrary backend applications are outside scope. CPU/memory/PID/time limits do not bound checkout/npm disk usage or prove hostile-code isolation. There is no submission-rate/queue-growth quota or measured capacity guarantee. Secret-looking `.env`/`.git` output paths are rejected, but secrets embedded in compiled JavaScript cannot be detected reliably.
