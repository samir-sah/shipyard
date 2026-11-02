# Benchmark and portfolio evidence

**Status: unmeasured.** Configuration limits are not measurements. Fill this report only from completed runs; keep raw results and failed attempts.

## Record the environment

```sh
node --version
npm --version
docker version
docker compose version
docker info
docker compose ps
```

Also record host OS, CPU model/core count, host RAM, Docker VM CPU/RAM allocation, disk type/free space, platform commit SHA, fixture URL/commit, package-lock hash, artifact file count/bytes, and internet connection conditions. On Windows, `Get-CimInstance Win32_Processor` and `Get-CimInstance Win32_OperatingSystem` report CPU and memory information. On Linux, use `lscpu`, `free -h`, and `df -h`.

## Workload

Use the trusted small Vite fixture from `DEMO.md`. First measure one cold build with a previously unused builder image and empty npm cache. Then run a separate warmup and a named series of repeated builds. Record whether image layers, Git, npm, filesystem, or S3 caches were warm. Do not mix cold and warm observations in one percentile.

Start at `WORKER_CONCURRENCY=1`, `BUILD_CPUS=1`, `BUILD_MEMORY_MB=512`, `BUILD_PIDS=128`, and `BUILD_TIMEOUT_MS=300000`. Queue several deployments; record successful completions, failures, and wall-clock elapsed time separately. Increase concurrency only after checking host memory and CPU capacity. For each setting, state queue depth, submission rate, number of samples, warmups, and whether other processes were active.

```sh
docker stats --no-stream
docker compose logs worker
```

Query persisted timing after a run with `docker compose exec postgres psql -U shipyard -d shipyard`, using the deployment timestamps defined in the schema. Queue wait is creation-to-claim. Build duration is claim-to-finish and includes checkout, install, validation, upload, and remote SHA-256/size verification. End-to-end latency is creation-to-finish.

Milestone 2 distinguishes a successful retained build from activation. Several deployments submitted for one project advance its generation; only the latest requested build may become active. Count all successful completed builds separately from active-pointer changes and failures. A successful superseded build remains `deployed` and contributes completed-build work, not an additional live release. Do not infer publication throughput from the count of successful rows.

Measure restore separately from builds: record the target version's file count/bytes, remote validation latency, total request latency, and whether builds were running concurrently. Restore reads and hashes the full target version before committing the pointer change, so its cost depends on artifact size and storage behavior. No restore latency has been measured here.

## Results template

| Metric | Result |
| --- | --- |
| Date/platform commit | Unmeasured |
| Hardware/Docker allocation | Unmeasured |
| Fixture commit/output bytes/files | Unmeasured |
| Cache condition/warmups | Unmeasured |
| Concurrency/sample count | Unmeasured |
| Successful builds/failed attempts | Unmeasured |
| Retained successes/active-pointer changes | Unmeasured |
| Queue wait median/p95 | Unmeasured |
| Build duration median/p95 | Unmeasured |
| End-to-end median/p95 | Unmeasured |
| Successful throughput, builds/minute | Unmeasured |
| Activation throughput, releases/minute | Unmeasured |
| Restore samples/bytes/files and median/p95 latency | Unmeasured |
| Peak memory/CPU and observed limit failures | Unmeasured |

Compute successful throughput from successful completions divided by measured wall-clock time. Count failures separately. Do not call configured concurrency “supported concurrency” until sustained runs complete under recorded host limits.

## Portfolio statements

Implemented-feature draft, subject to the verification record in `PLAN.md`:

> Built a self-hosted TypeScript deployment platform using React, PostgreSQL, BullMQ/Redis, Docker, and S3-compatible storage, with persisted build history and local static-site serving.

Milestone 2 feature draft, subject to completed integration/demo evidence:

> Added immutable artifact versions with SHA-256 validation, transaction-guarded latest-request publication, and rollback that supersedes in-progress builds while preserving their completed versions.

Measurement draft; replace every placeholder from collected evidence before use:

> Completed [successful builds]/[total attempts] Vite deployments at [concurrency] concurrent builds on [hardware], with [median/p95] queue wait and [median/p95] build duration under [CPU/memory/time] limits.

Milestone 2 implements rollback and ordering rules; describe their verification using actual recorded tests. Crash recovery, hostile-code isolation, production reliability, and supported concurrency remain unproven. Do not replace unmeasured placeholders with configuration defaults or test durations.
