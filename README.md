# Shipyard

Shipyard turns a supported public GitHub repository into a local static site. Submit a repository, follow its build logs, open an immutable deployment, and restore a completed version from the dashboard.

This repository implements **milestones 1 and 2** of a self-hosted portfolio project. The API and worker use TypeScript/Node.js, the dashboard uses React/Vite, PostgreSQL stores deployment records, BullMQ/Redis queues builds, Docker runs the build recipe, and SeaweedFS provides S3-compatible artifact storage. Recovery after worker failure is the next milestone.

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

The `builder` service is an image build target under the `tools` profile. Build it before submitting a deployment. Do not run that service directly; the worker creates one bounded container per deployment.

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

Integration tests need running local services and the explicit `RUN_INTEGRATION=1` environment variable. See [the demo guide](docs/DEMO.md) for end-to-end verification and [the benchmark template](docs/BENCHMARK.md) for measurements. Test results actually collected in this implementation session are recorded in [the plan](docs/PLAN.md#verification-record).

## Version selection and restore

Deployments persist `queued`, `building`, `failed`, or `deployed` state, timestamps, logs, and artifact locations. Each stable deployment ID has an immutable S3 prefix. The worker validates the local output, uploads files without overwriting existing objects, reads them back to verify their actual SHA-256 and size, and writes a completion manifest last. Only a complete version can be recorded as a successful new deployment. Queue wait and build duration are recorded separately.

**Latest requested build wins.** Creating a deployment advances the project's publication generation. A successful build changes the active pointer only if its generation is still current. If a newer request fails, an older build finishing later still cannot publish; the previously active site stays available. A superseded successful build remains `deployed` in history and can be opened or restored. The dashboard's **LIVE** marker identifies the active version.

Use **Restore** on a completed version, or send `POST /api/projects/<project-id>/rollback` with JSON `{"deploymentId":"<deployment-id>"}`. Restore checks every stored file against its manifest before a guarded database transaction changes the pointer and advances the generation. Earlier queued or running builds may finish as retained versions but cannot undo that restore. A build requested after restore can publish. Concurrent actions are ordered by PostgreSQL's project-row lock and committed transactions, not HTTP arrival time.

The stable `/sites/<slug>/` path returns a non-cacheable `302` redirect to `/versions/<slug>/<deployment-id>/`. Keep the stable link for the current release and the version link for a particular build.

## Upgrade an existing milestone 1 installation

Stop both application processes before updating. Old API/worker code does not honor publication generations, so mixed milestone 1 and milestone 2 processes are unsupported. Compose waits for the worker's current build within its configured shutdown grace period; investigate any forced stop before restarting.

```sh
docker compose stop api worker
git pull --ff-only
docker compose --profile tools build
docker compose up -d api worker
```

Keep PostgreSQL, Redis, and storage running with their existing volumes. Back up persisted state before upgrading. Startup applies an additive migration: project/history IDs and the active pointer remain, while old deployment manifests start as `NULL`. Restoring an old successful version verifies its existing objects and lazily creates its completion manifest; incomplete or corrupt versions are rejected. See [migration compatibility](docs/ARCHITECTURE.md#migration-compatibility).

An application downgrade also requires stopping **both** API and worker before checking out and rebuilding the older commit. Leave additive database columns intact; there is no automatic database downgrade. The old application loses milestone 2 ordering, restore, and immutable-write guarantees. Treat downgrading as a local operator procedure, not a supported mixed-version deployment.

## Current limits

Basic claims prevent simultaneous duplicate execution. Expiring claims, safe retries, worker recovery, stale-worker fencing, and abandoned-resource cleanup remain milestone 3. A killed worker may leave a `building` row, temporary Docker container, or incomplete unused artifact prefix requiring operator investigation.

This local demo has no authentication or ownership checks. Keep the ports bound to loopback. Build containers receive no platform secrets or Docker socket, but the worker itself controls the host Docker daemon. Artifact and log bounds do not bound checkout or dependency disk usage. There is no artifact retention policy yet.

See [the architecture](docs/ARCHITECTURE.md), [milestones and remaining work](docs/PLAN.md), and [demo procedure](docs/DEMO.md). Custom domains, Kubernetes, arbitrary backend applications, and additional build recipes remain outside this first version.
