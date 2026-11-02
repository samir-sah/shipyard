# Shipyard

Shipyard turns a supported public GitHub repository into a local static site. Submit a repository, follow its build logs, and open the completed site from the dashboard.

This repository implements **milestone 1** of a self-hosted portfolio project. The API and worker use TypeScript/Node.js, the dashboard uses React/Vite, PostgreSQL stores deployment records, BullMQ/Redis queues builds, Docker runs the build recipe, and SeaweedFS provides S3-compatible artifact storage.

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

| Setting | Milestone 1 |
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

The build script must accept Vite's `--base=./` argument. Paths inside the generated site must be relative. Extensionless paths fall back to `index.html` for client-side routing; files with extensions return 404 when missing. Use hash routing for the simplest path-hosted setup, or configure your router's base and asset paths for `/sites/<project-slug>/`.

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

The Vite dev server proxies API and site paths to port 3000. Host processes use values in `.env`; after changing its PostgreSQL password, keep `DATABASE_URL` consistent. Compose supplies internal service URLs automatically.

```sh
npm run typecheck
npm test
npm run build
```

Integration tests need running local services and the explicit `RUN_INTEGRATION=1` environment variable. See [the demo guide](docs/DEMO.md) for end-to-end verification and [the benchmark template](docs/BENCHMARK.md) for measurements. Test results actually collected in this implementation session are recorded in [the plan](docs/PLAN.md#verification-record).

## Current behavior and limits

Deployments persist `queued`, `building`, `failed`, or `deployed` state, timestamps, logs, and artifact locations. Each deployment has a stable ID and its own artifact prefix. A successful build validates and uploads its complete output before switching the active site. A failed build leaves the previous active site available. Queue wait and build duration are recorded separately.

Milestone 1 uses the last successful completion as the active version. Basic claims prevent simultaneous duplicate execution; full crash recovery, expired claims, stale-worker fencing, guarded ordering rules, and rollback are later milestones. A worker killed during a build may leave a `building` row and temporary Docker container requiring operator investigation.

This local demo has no authentication or ownership checks. Keep the ports bound to loopback. Build containers receive no platform secrets or Docker socket, but the worker itself controls the host Docker daemon. Artifact and log bounds do not bound checkout or dependency disk usage. There is no artifact retention policy yet.

See [the architecture](docs/ARCHITECTURE.md), [milestones and remaining work](docs/PLAN.md), and [demo procedure](docs/DEMO.md). Custom domains, Kubernetes, arbitrary backend applications, and additional build recipes remain outside this first version.
