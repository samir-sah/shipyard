# Reproducible demo

This procedure exercises milestones 1–3. Actual results belong in `PLAN.md`; this guide is a runnable procedure, not evidence that every step has already passed. Upgrade an existing milestone 1/2 installation using the coordinated API/worker stop in the README before running it.

## Prepare a trusted public fixture

Use a small Vite repository that you own, with a root `package.json`, committed `package-lock.json`, branch `main`, and output `dist/index.html`. Do not submit this Shipyard repository itself: its build produces the platform dashboard under `dist/dashboard`, outside the supported recipe.

To prepare a fixture locally:

```sh
npm create vite@latest shipyard-demo -- --template vanilla-ts
cd shipyard-demo
npm install
npm run build -- --base=./
git init -b main
git add .
git commit -m "Add Vite deployment fixture"
```

Publish that fixture to a public GitHub repository you control, preserving its lockfile. Review its build and install scripts before using it. Record the repository URL and commit SHA with the demo evidence. The instructions do not create a repository automatically.

## Successful deployment

1. Start Shipyard using the README instructions. Confirm `docker compose ps` shows healthy backing services and running API/worker.
2. Open `http://localhost:3000`, create a project with the trusted public fixture URL, and submit its deployment.
3. Follow the log panel through `queued`, `building`, and `deployed`. Record the deployment ID, commit, first queue wait, deployment elapsed time, attempt count, and configured limits. Attempt numbers appear in the logs; the history API includes `attemptCount`.
4. Open the displayed `/sites/<slug>/` URL. Confirm it redirects to `/versions/<slug>/<deployment-id>/` and HTML, JavaScript, CSS, and relative assets load.
5. Save the project ID, slug, active deployment ID **A**, immutable version URL, and a checksum or screenshot of the rendered page. This is the baseline for the failure and restore tests.

The helper automates submission, waits for completion, checks the served page, and prints timing. Add `--duplicate` to schedule the same ready expected attempt again. Job IDs include the stable deployment ID and expected attempt number. PostgreSQL claim checks remain authoritative even when duplicate queue delivery occurs; integration tests exercise those checks separately:

```sh
npm run demo -- --repo https://github.com/YOUR-ACCOUNT/YOUR-FIXTURE.git --name "Vite demo" --duplicate
```

Keep the printed project ID for later redeployments. `--base http://localhost:3000` overrides the API URL when necessary. Run this helper with no competing deployment/restore requests: its successful-run assertion expects its own deployment to become active. Its printed `buildDurationMs` is first-claim-to-terminal elapsed time, including retry wait/downtime. A demo-helper polling timeout is not proof that the persisted deployment failed; inspect history and logs.

## Failed build preserving the active site

1. In the same fixture repository, temporarily change its build script to `node -e "process.exit(1)"`, commit, and push `main`.
2. In the existing Shipyard project, trigger another deployment. Watch its failed attempts return to `queued` with backoff. With the default three-attempt limit, it must eventually finish terminally `failed` and expose errors in the logs.
3. Reload the original site URL. Its prior content must remain available, with the same active deployment as the baseline.
4. Restore the original build script in the fixture, commit, and push. Keep both fixture commit SHAs in the demo record.

After pushing the deliberately failing fixture commit, the helper can check the failed deployment and preserved active site:

```sh
npm run demo -- --project PROJECT-ID-FROM-THE-FIRST-RUN --expect-failure
```

Changing the build script deliberately is part of the fixture setup; do not break the platform's own build script. A failed latest request does not permit a still-running older request to publish. The baseline active deployment stays selected unless another valid action changes it.

## Restore and pinned version URLs

1. Change the fixture's visible content, commit, and push `main`. Trigger a successful deployment **B** in the same project.
2. Record B's ID and immutable URL. Verify the active site now redirects to B, while A's immutable URL still serves A's content.
3. Select a deployment's logs in the dashboard. Click **Restore** on A. The button is disabled while verification is pending; after success, **LIVE** must move to A without changing the selected logs.
4. Reload the stable site link. It must redirect to A. Open B's version link and confirm its HTML/assets still belong to B.
5. Restore B again if desired. Restore is reversible and does not create a new build or erase history.

The API alternative uses the project and deployment IDs printed earlier. Replace the uppercase placeholders before running these POSIX-shell examples:

```sh
curl --fail-with-body --request POST \
  http://localhost:3000/api/projects/PROJECT-ID/rollback \
  --header 'Content-Type: application/json' \
  --data '{"deploymentId":"DEPLOYMENT-A-ID"}'

curl --head http://localhost:3000/sites/PROJECT-SLUG/
curl --fail-with-body http://localhost:3000/versions/PROJECT-SLUG/DEPLOYMENT-A-ID/
curl --fail-with-body http://localhost:3000/versions/PROJECT-SLUG/DEPLOYMENT-B-ID/
```

The first response contains the updated project with `activeDeploymentId` set to A. The stable route must return `302`, `Cache-Control: no-store`, and a `Location` pointing to A's immutable version. Immutable version requests must return the matching content directly.

In PowerShell, the equivalent restore request is:

```powershell
$body = @{ deploymentId = 'DEPLOYMENT-A-ID' } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3000/api/projects/PROJECT-ID/rollback' `
  -ContentType 'application/json' -Body $body
```

Restore first verifies every stored object's actual SHA-256 and size against the completion manifest. An unavailable/incomplete version returns `409`; a missing, failed, or different project's deployment returns `404`. Neither changes active selection. A successful restore advances the project's generation, superseding all earlier queued/running builds. Such builds may finish as retained successful versions; they must not replace the restored site. A new build requested after restore can publish.

For an old milestone 1 successful version without a manifest, restore verifies its existing objects and lazily creates the marker and stored manifest. Existing history and active IDs are preserved during migration. Do not delete or modify storage objects to manufacture this situation on a project you want to keep; the integration suite creates isolated fixtures for compatibility and corruption cases.

## Worker crash and retry recovery

The deterministic recovery suite uses real PostgreSQL and S3-compatible storage with a child process running the deployment orchestrator. Its fake builder supplies prepared static output. The harness pauses actual S3 upload or completion-marker handling, terminates that child, and then exercises lease expiry, retry, and stale-token fencing. This tests the crash boundary without depending on public Git/npm timing; it does not demonstrate a full public checkout recipe.

For a separate manual local demo, use a trusted fixture that builds slowly enough to observe:

1. Keep a baseline deployment active. Request another deployment and wait for its `building` log.
2. Record its deployment ID and attempt count, then force-stop only the demo worker: `docker compose kill -s SIGKILL worker`.
3. Confirm the baseline site remains available. The abandoned build container has its own deadline and stops without the worker; it may remain until cleanup.
4. Restart the worker with `docker compose up -d worker`. Allow the old lease to expire, the five-second recovery scan to run, and retry backoff to elapse.
5. Observe a new attempt token/number for the same stable deployment. It must complete or exhaust its bounded retries without allowing the expired token to publish. Maintenance later removes abandoned labeled containers, volumes, local workspaces, and obsolete attempt objects.

Do not treat fixed sleeps as correctness evidence: record the actual persisted states and timestamps. Recovery depends on a running worker and reachable backing services. The default lease is 30 seconds and heartbeat interval is 10 seconds; downtime, queued work, and resource cleanup can extend observed recovery time. A retried build uses the recorded SHA after the first build pins it; a crash before that pin may resolve newer `main`.

Per-worker concurrency does not impose a strict machine-wide cap: an orphaned container can overlap its replacement until its own timeout or cleanup. Builds keep their CPU/memory/PID limits. Use the Docker integration checks below to inspect the resource settings, and collect machine-capacity measurements separately.

## Focused checks

```sh
npm ci
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

Integration tests use real PostgreSQL transactions and S3-compatible storage. Start `postgres`, `redis`, and `storage` using Compose first. Set `RUN_INTEGRATION=1` in the shell and run `npm run test:integration`; tests skip when the explicit flag is absent.

```sh
docker compose up -d --wait postgres redis storage
RUN_INTEGRATION=1 npm run test:integration
```

In PowerShell, use `$env:RUN_INTEGRATION='1'` followed by `npm run test:integration`. To include Linux Docker resource-inspection and janitor checks, first build the images and opt in explicitly:

```sh
docker compose --profile tools build
RUN_INTEGRATION=1 RUN_DOCKER_TESTS=1 npm run test:integration
```

In PowerShell, set both `$env:RUN_INTEGRATION='1'` and `$env:RUN_DOCKER_TESTS='1'` before running the tests. The Docker cases inspect configured resource limits and cleanup behavior and check that a short-lived container deadline fires independently. They do not measure supported workload concurrency. CI enables these checks on its Linux Docker host; inspect the actual result before claiming success. Full public Docker checkout/builds remain a separate demo-helper procedure.

The persistence suites cover competing expected attempts, expired claims, stale renewal/log/pin/failure/publication rejection, bounded retry exhaustion, cleanup eligibility, failed-build preservation, out-of-order completion, rollback races, and additive migrations. The S3/HTTP suites cover isolated attempt prefixes, immutable writes, completion markers, content validation, legacy versions, and pinned serving. The child-process recovery harness adds real upload/marker crash boundaries. Passing these tests is narrower than proving arbitrary infrastructure failure recovery or hostile-code isolation.

## Remaining acceptance demonstrations

Do not present the following as completed evidence merely because their procedures or tests exist:

- Duplicate delivery across retry/crash boundaries, child termination during upload, and Docker cleanup: implemented milestone 3 cases; collect their actual run results.
- Out-of-order completion and rollback overlapping a build: implemented milestone 2 integration cases; collect their actual run results.
- Signed webhook delivery, ownership, retention, and host-based routing: milestone 4.

Database tokens and leases govern duplicate/recovery safety. Test evidence still applies only to the scenarios and infrastructure actually exercised.

## Troubleshooting

- Docker connection errors: start Docker Desktop/Engine in Linux-container mode and rerun `docker info`.
- Missing `shipyard-builder:local`: run `docker compose --profile tools build builder`.
- Dependency install failure: ensure the fixture has a compatible `package-lock.json` on `main`; inspect the deployment log.
- Missing `dist/index.html`: check the repository build script and output directory against the supported recipe.
- Existing site assets fail: use relative URLs and rebuild with `--base=./`; avoid browser APIs restricted by the local sandbox.
- A successful build is not marked LIVE: a newer request or restore superseded its publication generation. Open its immutable version or restore it explicitly.
- Restore reports `409`: inspect storage availability and version integrity. Do not bypass the completion manifest or change the active pointer manually.
- M1/M2 upgrade behaves inconsistently: stop both API and worker and verify they run the same rebuilt code. Mixed tokenless/current processes are unsupported.
- A deployment remains `building` after forced termination: confirm a worker is running, the lease is expired, and database/Redis access works. Recovery scans every five seconds; do not bypass claim checks or reset database status manually.
- Old Docker objects remain: inspect their `shipyard.managed`/claim labels and whether the token is active. Maintenance is bounded; pre-milestone-3 unlabeled resources are outside automatic token cleanup.
