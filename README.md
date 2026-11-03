# Shipyard

Shipyard turns a supported public GitHub repository into a local static site. Submit a repository, follow its build logs, open an immutable deployment, and restore a completed version from the dashboard.

This repository implements **milestones 1–3** of a self-hosted portfolio project. The API and worker use TypeScript/Node.js, the dashboard uses React/Vite, PostgreSQL stores deployment records and worker leases, BullMQ/Redis schedules build attempts, Docker runs the build recipe, and SeaweedFS provides S3-compatible artifact storage. Authentication, ownership, webhooks, separate site origins, and retention are the next milestone.

## Run locally

Requires Docker Engine with Linux containers and Docker Compose v2. On Windows/macOS, start Docker Desktop first. Allow at least 2 CPUs, 4 GiB RAM, and 5 GiB free disk for a small demo. These are setup recommendations, not measured capacity.

```sh
git clone https://github.com/samir-sah/shipyard.git
cd shipyard
cp .env.example .env
docker compose --profile tools build
docker compose up -d --build
docker compose logs -f api worker
```

In PowerShell, use `Copy-Item .env.example .env` instead of `cp` if preferred. Open [the dashboard](http://localhost:3000). The API and all development services bind only to the local machine. Named Docker volumes preserve metadata, queued jobs, and artifacts across restarts.

The `builder` service is an image build target under the `tools` profile. Build it before submitting a deployment. Do not run that service directly; the worker creates one bounded container and named work volume per build attempt.

Stop services with `docker compose down`. Avoid `docker compose down -v` when keeping deployment history: `-v` deletes the database, queue, and artifact volumes.

## Supported repository recipe

| Setting | Supported recipe |
| --- | --- |
| Source | Public HTTPS GitHub URL, `https://github.com/owner/repo.git` |
| Branch | `main` |
| Project directory | Repository root |
| Lockfile | Committed `package-lock.json` |
| Install | `npm ci` |
| Build | `npm run build -- --base=./` |
| Output | `dist/`, containing `index.html` |
| Runtime | Node.js 24 in the builder image |
| Site URL | `http://localhost:3000/sites/<project-slug>/` |
| Immutable version URL | `http://localhost:3000/versions/<project-slug>/<deployment-id>/` |

The build script must accept Vite's `--base=./` argument. Paths inside the generated site must be relative. The active site path redirects to its immutable version URL, keeping the document and its relative assets on the same deployment after another release. Extensionless version paths fall back to `index.html`; files with extensions return 404 when missing. Hash routing is the simplest path-hosted choice. History routers need a base matching the immutable version path, with care for relative assets on nested routes.

Deployed pages run under a browser sandbox because the local path fallback shares the dashboard's host. Scripts and module assets work, but local storage, cookies, service workers, and APIs needing a normal same-origin document are unsupported. Separate site origins are planned in milestone 4.

Use repositories you trust. Dependency install scripts and the repository build command execute code and can access the network. See [the build threat model](docs/ARCHITECTURE.md#build-threat-model).

## Development and checks

Host development requires Node.js 22.12+; supported Node.js 24 LTS is recommended. Exact npm versions are recorded in `package-lock.json`.

```sh
npm ci
docker compose --profile tools build builder
docker compose up -d postgres redis storage
npm run dev:api
# In separate terminals:
npm run dev:worker
npm run dev:dashboard
```

The Vite dev server proxies API, active site, and immutable version paths to port 3000. Host processes use values in `.env`; after changing its PostgreSQL password, keep `DATABASE_URL` consistent. Compose supplies internal service URLs automatically.

```sh
npm run typecheck
npm test
npm run build
```

Integration tests need running local services and the explicit `RUN_INTEGRATION=1` environment variable. Docker resource/cleanup tests additionally require a working Linux Docker daemon and `RUN_DOCKER_TESTS=1`. See [the demo guide](docs/DEMO.md) for recovery and end-to-end verification and [the benchmark template](docs/BENCHMARK.md) for measurements. Actual results are recorded in [the plan](docs/PLAN.md#verification-record).

## Version selection and restore

Deployments persist `queued`, `building`, `failed`, or `deployed` state, timestamps, logs, attempt counts, and artifact selection. Each attempt writes an immutable S3 prefix under its stable deployment ID. The worker validates the local output, uploads without overwriting existing objects, reads files back to verify actual SHA-256 and size, and writes a completion manifest last. Only a complete version can become a successful new deployment. Queue wait and deployment elapsed time are recorded separately; the API field `buildDurationMs` includes retry waits and worker downtime after the first claim.

**Latest requested build wins.** Creating a deployment advances the project's publication generation. A successful build changes the active pointer only if its generation is still current. If a newer request fails, an older build finishing later still cannot publish; the previously active site stays available. A superseded successful build remains `deployed` in history and can be opened or restored. The dashboard's **LIVE** marker identifies the active version.

Use **Restore** on a completed version, or send `POST /api/projects/<project-id>/rollback` with JSON `{"deploymentId":"<deployment-id>"}`. Restore checks every stored file against its manifest before a guarded database transaction changes the pointer and advances the generation. Earlier queued or running builds may finish as retained versions but cannot undo that restore. A build requested after restore can publish. Concurrent actions are ordered by PostgreSQL's project-row lock and committed transactions, not HTTP arrival time.

The stable `/sites/<slug>/` path returns a non-cacheable `302` redirect to `/versions/<slug>/<deployment-id>/`. Keep the stable link for the current release and the version link for a particular build.

## Worker recovery and retries

PostgreSQL grants each attempt a unique token and a 30-second lease, renewed every 10 seconds by default. Logs, commit pinning, failure transitions, and publication require the current unexpired token. A duplicate or stale queue delivery cannot claim a different expected attempt. BullMQ deduplication is useful, but the database is the authority.

The worker scans expired leases and ready queued deployments every five seconds. Failures and expired claims retry up to `MAX_BUILD_ATTEMPTS=3`, with 1-second, 2-second, then exponentially increasing delays capped at 60 seconds when more attempts are configured. Builder and upload errors share this bounded retry policy; a deterministic bad build also consumes its attempts before becoming terminally `failed`.

The first completed build pins its Git SHA before upload. Later attempts fetch that SHA. A crash before the SHA is recorded may resolve a newer `main` on retry. Each attempt has a separate token, Docker container/volume, temporary directory, and artifact prefix; stale uploads cannot overwrite the selected attempt's output or publish without the database fence.

The build container also enforces its own deadline, with a 10-second forced-kill grace, even if its worker disappears. Normal completion cleans Docker resources and temporary files. A maintenance pass every 60 seconds removes abandoned labeled resources and failed/expired attempt prefixes, preserving active claims and selected/retained successful versions. Cleanup is bounded and best effort; crashes or a large backlog can leave resources until later passes. See [recovery and cleanup](docs/ARCHITECTURE.md#worker-leases-retries-and-cleanup).

## Upgrade an existing milestone 1 or 2 installation

Stop both application processes before updating. Old code lacks the current generation, lease-token, or attempt-prefix rules, so mixed application versions are unsupported. Compose waits for the worker's current attempt within its configured shutdown grace period; investigate any forced stop before restarting.

```sh
docker compose stop api worker
git pull --ff-only
docker compose --profile tools build
docker compose up -d api worker
```

Keep PostgreSQL, Redis, and storage running with their existing volumes. Back up persisted state before upgrading. Startup applies additive migrations: project/history IDs, existing manifests, and the active pointer remain. Migration 003 requeues old `building` rows after the coordinated stop. Milestone 1 versions without manifests retain their legacy read path; restore verifies the discoverable objects and lazily seals them. Existing milestone 2 root-prefix versions remain readable and restorable. See [migration compatibility](docs/ARCHITECTURE.md#migration-compatibility).

There is no automatic database or application downgrade. Older applications cannot read newly published milestone 3 attempt prefixes, even though the schema changes are additive. Any local downgrade requires stopping **both** API and worker and a compatibility or backup plan for the selected artifacts; checking out old code alone is insufficient. Do not mix tokenless old workers with the current application.

## Current limits

Recovery requires a running worker, reachable PostgreSQL/Redis/storage, and working Docker cleanup. Database fencing prevents stale publication; it does not stop an unreachable process instantly. Per-worker concurrency is not a strict machine-wide cap: an orphaned container can overlap a replacement until timeout or cleanup. A worker can clean only its own local temporary directories, while labeled containers/volumes are visible on its Docker daemon. Old unlabeled resources need operator review. Machine capacity remains unmeasured.

This local demo has no authentication or ownership checks. Keep ports bound to loopback. Build containers receive no platform secrets or Docker socket, but the worker controls the host Docker daemon. CPU, memory, PID, and per-attempt time limits do not bound checkout/dependency disk usage. Builds can access the network, deployment submission has no queue-growth quota, and successful artifact retention is unbounded. Use trusted repositories only.

See [the architecture](docs/ARCHITECTURE.md), [milestones and remaining work](docs/PLAN.md), and [demo procedure](docs/DEMO.md). Custom domains, Kubernetes, arbitrary backend applications, and additional build recipes remain outside this first version.
