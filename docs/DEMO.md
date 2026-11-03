# Reproducible demo

This procedure exercises all four milestones. Actual results belong in `PLAN.md`; these steps are not evidence that they have already passed. Upgrade older installations using the coordinated API/worker stop and credential setup in the README. Retention stays disabled by default.

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
2. Run `npm run setup`, open `http://localhost:3000`, and sign in with the private operator access token from your local `.env`. Create a project with the trusted public fixture URL.
3. Follow the log panel through `queued`, `building`, and `deployed`. Record the deployment ID, commit, first queue wait, deployment elapsed time, attempt count, and configured limits. Attempt numbers appear in the logs; the history API includes `attemptCount`.
4. Open the displayed `http://<slug>.sites.localhost:3000/` URL. Confirm it redirects to `/_shipyard/v/<deployment-id>/` and HTML, JavaScript, CSS and relative assets load. The dashboard-host `/sites/<slug>/` fallback still redirects to `/versions/<slug>/<id>/` under its opaque-origin sandbox.
5. Save the project ID, slug, active deployment ID **A**, immutable version URL, and a checksum or screenshot of the rendered page. This is the baseline for the failure and restore tests.

The helper automates submission, waits for completion, checks the served page, and prints timing. Add `--duplicate` to schedule the same ready expected attempt again. Job IDs include the stable deployment ID and expected attempt number. PostgreSQL claim checks remain authoritative even when duplicate queue delivery occurs; integration tests exercise those checks separately:

```sh
export SHIPYARD_TOKEN='REPLACE_WITH_YOUR_PRIVATE_OPERATOR_KEY'
npm run demo -- --repo https://github.com/YOUR-ACCOUNT/YOUR-FIXTURE.git --name "Vite demo" --duplicate
```

Replace that token placeholder; it is not a working credential. In PowerShell, set `$env:SHIPYARD_TOKEN` to the private operator key. The helper does not choose credentials automatically. Keep the printed project ID for later redeployments. `--base http://localhost:3000` overrides the dashboard API URL. Run with no competing deployment/restore requests: the successful-run assertion expects its own deployment to become active. Its printed `buildDurationMs` includes retry wait/downtime. A polling timeout is not proof of terminal failure; inspect history/logs. The helper checks the sandboxed fallback page; use the browser steps to inspect the project host.

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
  --header "Authorization: Bearer $SHIPYARD_TOKEN" \
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
$headers = @{ Authorization = "Bearer $env:SHIPYARD_TOKEN" }
Invoke-RestMethod -Method Post `
  -Uri 'http://localhost:3000/api/projects/PROJECT-ID/rollback' `
  -Headers $headers -ContentType 'application/json' -Body $body
```

Restore verifies every stored object's SHA-256/size against its saved manifest. A corrupt/unavailable stored object returns `409`; a missing, failed, deleting/deleted, or different project's target returns `404`. Neither changes active selection. A successful restore advances the generation, superseding earlier queued/running builds. They may finish as historical successful versions but must not replace the restored site. A later request can publish. Version reads return `410` after retention claims deletion.

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
npm run setup
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

The persistence suites cover competing expected attempts, expired claims, stale fences, retry exhaustion, cleanup, failed-build preservation, ordering, rollback races and additive migrations. S3/HTTP cases cover immutable attempts, completion markers, checksums, legacy compatibility and pinned serving. The killed-child harness tests real upload/marker crash boundaries with prepared build output. M4 adds ownership/session, signed-delivery, host-routing, Keep and retention cases. Destructive maintenance fixtures use random isolated PostgreSQL schemas before touching retention state, preserving existing development projects. Passing these cases does not prove arbitrary infrastructure recovery or hostile-code isolation.

## Ownership and separate browser origins

1. Add a second operator using the private configuration procedure in [DEPLOYMENT.md](DEPLOYMENT.md#accounts-and-secret-rotation), then recreate the API.
2. Sign in as the second operator in another browser profile. The first operator's projects must be absent. Direct management requests for their project/history/logs/restore/Keep must return 404; a missing/invalid access key returns 401.
3. Open the first project's public site without a session. It should remain readable: publication is intentionally public.
4. On a project host, request `/api/session` and `/health`; both must return 404. Normal local storage and a correctly version-scoped service worker can work there. Check the same APIs are unavailable on the dashboard-host sandbox fallback.
5. Record actual browser, resolver and operating-system details. If `*.sites.localhost` does not resolve, use the path fallback or explicit local DNS mapping; do not call an untested host setup complete.

## Signed GitHub webhook

1. Use a trusted repository that you control. In the owning project's dashboard, enable its webhook and privately copy the returned URL and project secret. The API needs its generated `GITHUB_WEBHOOK_KEY` configured.
2. Configure a GitHub repository webhook with that payload URL, JSON content type, returned secret and push events. GitHub needs a reachable HTTPS endpoint; localhost is not reachable from GitHub. A local forwarding service is separate operator setup. GitHub documents [delivery handling](https://docs.github.com/en/webhooks/using-webhooks/handling-webhook-deliveries) and [signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
3. Push a visible change to `main`. Record the delivery GUID, `after` SHA and created deployment ID. Verify the deployment pins that SHA rather than resolving a later branch head.
4. Redeliver the same GitHub delivery. It must refer to the original deployment without incrementing its generation or creating another build. Signed reuse of the same GUID with changed bytes/event returns 409; automated tests construct that conflict without modifying a live delivery.
5. Push another branch or delete a ref. Valid ignored deliveries should be recorded without a deployment. Rotate the project secret in Shipyard, update GitHub, and verify the previous secret no longer works. Disabling also invalidates the previous configuration.

Signatures cover the exact raw body, bounded to 1 MiB, and the API validates the repository/ref. Keep master, per-project and operator keys private. Publication follows accepted project transaction order; deliberately delayed earlier push events can still receive a newer generation. No GitHub chronology/head freshness guarantee is claimed.

## Keep and retention

Use **Keep** on a completed available version. Confirm the flag persists and does not change the active pointer, rebuild the site or delete artifacts. A different owner cannot change it. Restoring and keeping versions already marked deleting/deleted is rejected.

Actual deletion is exercised by isolated integration fixtures, which create old versions and test active/manual/newest protection, deletion/restore races, tombstone retry and 410 serving. Run the opted-in suite against development infrastructure to collect that evidence. Leave `RETENTION_DAYS=0` on projects you want to preserve; do not backdate real deployments or enable a purge to manufacture a demo.

For an intentional operated installation, follow [the retention procedure](DEPLOYMENT.md#retention-and-failure-handling). A positive age enables irreversible artifact deletion, with `RETENTION_KEEP` newest successful versions, active and Keep versions protected. Changing the age back to zero stops new claims; already deleting jobs still complete. History/logs remain, and there is no undelete API.

## Remaining acceptance demonstrations

Do not present the following as completed evidence merely because their procedures or tests exist:

- Milestone 2 ordering/rollback and milestone 3 recovery cases have the CI results linked in `PLAN.md`; retain their exact infrastructure/scenario limits.
- Milestone 4 ownership, signed delivery, host routing and retention are implemented; collect their actual final CI and browser results before claiming verification.
- Public Git checkout through the fixed Docker recipe, browser interaction, HTTPS/proxy setup and the benchmark workload still need recorded demonstrations.

Database tokens and leases govern duplicate/recovery safety. Test evidence still applies only to the scenarios and infrastructure actually exercised.

## Troubleshooting

- Docker connection errors: start Docker Desktop/Engine in Linux-container mode and rerun `docker info`.
- Missing `shipyard-builder:local`: run `docker compose --profile tools build builder`.
- API exits for missing credentials: run `npm run setup`, retain the generated `.env`, and recreate the API container.
- API returns 401: use the current operator access key or sign in again after key rotation.
- API returns 404 for a project: verify you are using its owning configured identity.
- Dependency install failure: ensure the fixture has a compatible `package-lock.json` on `main`; inspect the deployment log.
- Missing `dist/index.html`: check the repository build script and output directory against the supported recipe.
- Existing site assets fail: use relative URLs and rebuild with `--base=./`; check the version basename and whether the URL is the sandbox fallback.
- A successful build is not marked LIVE: a newer request or restore superseded its publication generation. Open its immutable version or restore it explicitly.
- Restore reports `409`: inspect storage availability and version integrity. Do not bypass the completion manifest or change the active pointer manually.
- M1/M2 upgrade behaves inconsistently: stop both API and worker and verify they run the same rebuilt code. Mixed tokenless/current processes are unsupported.
- A deployment remains `building` after forced termination: confirm a worker is running, the lease is expired, and database/Redis access works. Recovery scans every five seconds; do not bypass claim checks or reset database status manually.
- Old Docker objects remain: inspect their `shipyard.managed`/claim labels and whether the token is active. Maintenance is bounded; pre-milestone-3 unlabeled resources are outside automatic token cleanup.
- Webhook returns 401/409: verify the current per-project secret, raw body, delivery ID and key rotation; do not log the secret while diagnosing.
- Version returns 410: retention has begun or completed artifact deletion. Use another available version or rebuild; inspect backups separately.
