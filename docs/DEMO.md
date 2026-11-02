# Reproducible demo

This procedure exercises milestone 1. The implementation session's actual results belong in `PLAN.md`; this guide is a runnable procedure, not evidence that every step has already passed.

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
4. Open the displayed `/sites/<slug>/` URL. Confirm HTML, JavaScript, CSS, and relative assets load.
5. Save the active deployment ID and a checksum or screenshot of the rendered page. This is the baseline for the failure test.

The helper automates submission, waits for completion, checks the served page, and prints timing. Add `--duplicate` to deliver the same stable job ID again. BullMQ deduplicates a retained job ID; the separate persistence integration test exercises competing claims:

```sh
npm run demo -- --repo https://github.com/YOUR-ACCOUNT/YOUR-FIXTURE.git --name "Vite demo" --duplicate
```

Keep the printed project ID for later redeployments. `--base http://localhost:3000` overrides the API URL when necessary.

## Failed build preserving the active site

1. In the same fixture repository, temporarily change its build script to `node -e "process.exit(1)"`, commit, and push `main`.
2. In the existing Shipyard project, trigger another deployment. It must finish `failed` and expose its error in the log panel.
3. Reload the original site URL. Its prior content must remain available, with the same active deployment as the baseline.
4. Restore the original build script in the fixture, commit, and push. Keep both fixture commit SHAs in the demo record.

After pushing the deliberately failing fixture commit, the helper can check the failed deployment and preserved active site:

```sh
npm run demo -- --project PROJECT-ID-FROM-THE-FIRST-RUN --expect-failure
```

Changing the build script deliberately is part of the fixture setup; do not break the platform's own build script.

## Focused checks

```sh
npm ci
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

Integration tests exercise PostgreSQL state/claims and S3 artifact round trips. Start `postgres`, `redis`, and `storage` using Compose first. Set `RUN_INTEGRATION=1` in the shell and run `npm run test:integration`; tests skip when the explicit flag is absent. In PowerShell: `$env:RUN_INTEGRATION='1'`; in a POSIX shell: `RUN_INTEGRATION=1 npm run test:integration`. Full Docker builds are exercised separately by the demo helper.

## Remaining acceptance demonstrations

Do not present the following as complete milestone 1 evidence:

- Duplicate delivery across crash/retry boundaries and a terminated worker during upload: milestone 3.
- Out-of-order completion and rollback overlapping a build: milestone 2.
- Signed webhook delivery, ownership, retention, and host-based routing: milestone 4.

Ordinary duplicate scheduling has basic claim protection. That is narrower than safe recovery after arbitrary worker failure.

## Troubleshooting

- Docker connection errors: start Docker Desktop/Engine in Linux-container mode and rerun `docker info`.
- Missing `shipyard-builder:local`: run `docker compose --profile tools build builder`.
- Dependency install failure: ensure the fixture has a compatible `package-lock.json` on `main`; inspect the deployment log.
- Missing `dist/index.html`: check the repository build script and output directory against the supported recipe.
- Existing site assets fail: use relative URLs and rebuild with `--base=./`; avoid browser APIs restricted by the local sandbox.
- A deployment remains `building` after forced termination: inspect worker and Docker state. Automatic expired-claim recovery is a later milestone; do not change database status while an old worker may still publish.
