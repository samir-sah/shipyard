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

Query persisted timing after a run with `docker compose exec postgres psql -U shipyard -d shipyard`, using the deployment timestamps defined in the schema. Queue wait is creation-to-claim. Build duration is claim-to-finish and includes checkout/install/upload. End-to-end latency is creation-to-finish.

## Results template

| Metric | Result |
| --- | --- |
| Date/platform commit | Unmeasured |
| Hardware/Docker allocation | Unmeasured |
| Fixture commit/output bytes/files | Unmeasured |
| Cache condition/warmups | Unmeasured |
| Concurrency/sample count | Unmeasured |
| Successful builds/failed attempts | Unmeasured |
| Queue wait median/p95 | Unmeasured |
| Build duration median/p95 | Unmeasured |
| End-to-end median/p95 | Unmeasured |
| Successful throughput, builds/minute | Unmeasured |
| Peak memory/CPU and observed limit failures | Unmeasured |

Compute successful throughput from successful completions divided by measured wall-clock time. Count failures separately. Do not call configured concurrency “supported concurrency” until sustained runs complete under recorded host limits.

## Portfolio statements

Implemented-feature draft, subject to the verification record in `PLAN.md`:

> Built a self-hosted TypeScript deployment platform using React, PostgreSQL, BullMQ/Redis, Docker, and S3-compatible storage, with persisted build history and local static-site serving.

Measurement draft; replace every placeholder from collected evidence before use:

> Completed [successful builds]/[total attempts] Vite deployments at [concurrency] concurrent builds on [hardware], with [median/p95] queue wait and [median/p95] build duration under [CPU/memory/time] limits.

Do not claim rollback, crash recovery, hostile-code isolation, or production reliability from the milestone 1 implementation.
