# Reproducible demo

This procedure exercises milestones 1 and 2. The implementation session's actual results belong in `PLAN.md`; this guide is a runnable procedure, not evidence that every step has already passed. Upgrade an existing milestone 1 installation using the coordinated API/worker stop in the README before running it.

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
3. Follow the log panel through `queued`, `building`, and `deployed`. Record the deployment ID, commit, queue wait, build duration, and configured limits.
4. Open the displayed `/sites/<slug>/` URL. Confirm it redirects to `/versions/<slug>/<deployment-id>/` and HTML, JavaScript, CSS, and relative assets load.
5. Save the project ID, slug, active deployment ID **A**, immutable version URL, and a checksum or screenshot of the rendered page. This is the baseline for the failure and restore tests.

The helper automates submission, waits for completion, checks the served page, and prints timing. Add `--duplicate` to deliver the same stable job ID again. BullMQ deduplicates a retained job ID; the separate persistence integration test exercises competing claims:

```sh
npm run demo -- --repo https://github.com/YOUR-ACCOUNT/YOUR-FIXTURE.git --name "Vite demo" --duplicate
```

Keep the printed project ID for later redeployments. `--base http://localhost:3000` overrides the API URL when necessary. Run this helper with no competing deployment/restore requests: its successful-run assertion expects its own deployment to become active.

## Failed build preserving the active site

1. In the same fixture repository, temporarily change its build script to `node -e "process.exit(1)"`, commit, and push `main`.
2. In the existing Shipyard project, trigger another deployment. It must finish `failed` and expose its error in the log panel.
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

In PowerShell, use `$env:RUN_INTEGRATION='1'` followed by `npm run test:integration`. Full Docker checkout/builds are exercised separately by the demo helper. CI also has an integration job that starts backing services, builds the platform and builder images, and runs the opt-in tests; inspect its actual result before claiming success.

The persistence suite covers competing claims, failed-build preservation, B finishing before A, a failed newer request suppressing an older completion, rollback overlapping completion, builds requested after rollback, invalid restore targets, and additive migration preservation. The S3 suite covers immutable writes, completion markers, actual content validation, incomplete prefixes, legacy sealing, and altered/missing objects. These controlled database/storage tests demonstrate publication rules when run; they do not simulate a full worker crash or prove hostile-code isolation.

## Remaining acceptance demonstrations

Do not present the following as completed evidence merely because their procedures or tests exist:

- Duplicate delivery across crash/retry boundaries and a terminated worker during upload: milestone 3.
- Out-of-order completion and rollback overlapping a build: implemented milestone 2 integration cases; collect their actual run results.
- Signed webhook delivery, ownership, retention, and host-based routing: milestone 4.

Ordinary duplicate scheduling has basic claim protection. That is narrower than safe recovery after arbitrary worker failure.

## Troubleshooting

- Docker connection errors: start Docker Desktop/Engine in Linux-container mode and rerun `docker info`.
- Missing `shipyard-builder:local`: run `docker compose --profile tools build builder`.
- Dependency install failure: ensure the fixture has a compatible `package-lock.json` on `main`; inspect the deployment log.
- Missing `dist/index.html`: check the repository build script and output directory against the supported recipe.
- Existing site assets fail: use relative URLs and rebuild with `--base=./`; avoid browser APIs restricted by the local sandbox.
- A successful build is not marked LIVE: a newer request or restore superseded its publication generation. Open its immutable version or restore it explicitly.
- Restore reports `409`: inspect storage availability and version integrity. Do not bypass the completion manifest or change the active pointer manually.
- M1 upgrade behaves inconsistently: stop both API and worker and verify they run the same rebuilt code. Mixed generations of application processes are unsupported.
- A deployment remains `building` after forced termination: inspect worker and Docker state. Automatic expired-claim recovery is a later milestone; do not change database status while an old worker may still publish.
