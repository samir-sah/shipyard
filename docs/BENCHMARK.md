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

Use the trusted small Vite fixture from `DEMO.md`. First measure one cold build with a previously unused builder image and empty npm cache. Then run a separate warmup and a named series of repeated builds. Each attempt has a fresh work volume and temporary npm cache; repeated deployments do not share a persistent npm install cache. Record whether image layers, filesystem, network, or S3 caches were warm. Do not mix cold and warm observations in one percentile.

Start at `WORKER_CONCURRENCY=1`, `BUILD_CPUS=1`, `BUILD_MEMORY_MB=512`, `BUILD_PIDS=128`, `BUILD_TIMEOUT_MS=300000`, `WORKER_LEASE_MS=30000`, and `MAX_BUILD_ATTEMPTS=3`. Queue several deployments; record successful completions, terminal failures, failed/expired attempts, and wall-clock elapsed time separately. Increase concurrency only after checking host memory and CPU capacity. For each setting, state worker-process count, queue depth, submission rate, samples, warmups, and other active processes.

```sh
docker stats --no-stream
docker compose logs worker
```

Query persisted timing with `docker compose exec postgres psql -U shipyard -d shipyard`. `queueWaitMs` is creation-to-first-claim. The legacy API field `buildDurationMs` is **deployment elapsed time after the first claim**: it includes all attempts, retry backoff, later queue waits, worker downtime, validation/upload, and cleanup until terminal completion. It is not pure build execution or CPU time. End-to-end latency is creation-to-terminal-finish.

Use `build_attempts.started_at`, `finished_at`, `status`, and `attempt_number` to report attempts separately. An expired attempt finishes in the ledger when recovery records expiry, not necessarily when its process stopped. Report such intervals as operational wall time. Record the time of injected failure, claim expiry, next claim, and terminal completion when measuring recovery; do not substitute configured lease/backoff values for observed latency.

Successful retained builds remain distinct from activation. Several deployments submitted for one project advance its generation; only the latest requested build may become active. Count successful deployment completions separately from active-pointer changes and failed attempts. A superseded success remains `deployed` and contributes completed-deployment work, not an additional live release. Do not infer publication throughput from successful rows or count retries as distinct successful deployments.

`WORKER_CONCURRENCY` limits one worker process's active jobs. It does not establish a global machine limit. After lease loss, an orphaned container can overlap a replacement until its autonomous timeout or cleanup. Record observed simultaneous containers and peak host load during recovery, plus how long abandoned resources take to disappear. The container's autonomous deadline and per-container limits bound individual work; they do not prove that the machine supports a configured aggregate concurrency.

Measure restore separately from builds: record the target version's file count/bytes, remote validation latency, total request latency, and whether builds were running concurrently. Restore reads and hashes the full target version before committing the pointer change, so its cost depends on artifact size and storage behavior. No restore latency has been measured here.

## Results template

| Metric | Result |
| --- | --- |
| Date/platform commit | Unmeasured |
| Hardware/Docker allocation | Unmeasured |
| Fixture commit/output bytes/files | Unmeasured |
| Cache condition/warmups | Unmeasured |
| Worker processes/configured concurrency/sample count | Unmeasured |
| Successful deployments/terminal failures/failed or expired attempts | Unmeasured |
| Retained successes/active-pointer changes | Unmeasured |
| First queue wait median/p95 | Unmeasured |
| Deployment elapsed after first claim median/p95 | Unmeasured |
| Per-attempt operational intervals/retry count | Unmeasured |
| Injected failure to next claim/terminal completion | Unmeasured |
| Orphan overlap/cleanup latency | Unmeasured |
| End-to-end median/p95 | Unmeasured |
| Successful throughput, deployments/minute | Unmeasured |
| Activation throughput, releases/minute | Unmeasured |
| Restore samples/bytes/files and median/p95 latency | Unmeasured |
| Peak memory/CPU and observed limit failures | Unmeasured |

Compute successful throughput from terminal successful deployments divided by measured wall-clock time. Count terminal failures and failed/expired attempts separately. Do not call configured concurrency “supported concurrency” until sustained runs complete under recorded host limits. Queue/request growth and checkout/npm disk usage remain unbounded by platform quotas and must be observed during the workload.

## Portfolio statements

Implemented-feature draft, subject to the verification record in `PLAN.md`:

> Built a self-hosted TypeScript deployment platform using React, PostgreSQL, BullMQ/Redis, Docker, and S3-compatible storage, with persisted build history and local static-site serving.

Milestone 2 feature draft, subject to completed integration/demo evidence:

> Added immutable artifact versions with SHA-256 validation, transaction-guarded latest-request publication, and rollback that supersedes in-progress builds while preserving their completed versions.

Milestone 3 feature draft, subject to the recorded recovery tests:

> Added PostgreSQL worker leases and attempt-token publication fencing, bounded retries, isolated artifact attempts, and cleanup of abandoned build resources.

Measurement draft; replace every placeholder from collected evidence before use:

> Completed [successful deployments]/[submitted deployments] Vite deployments using [worker processes/concurrency] on [hardware], with [median/p95] first queue wait and [median/p95] deployment elapsed time, including [failed/expired attempts] under [CPU/memory/time] limits.

Describe rollback, ordering, and worker-recovery verification using actual recorded scenarios. The recovery harness uses a fake builder with real persistence/storage; it is not public Git build throughput evidence. Hostile-code isolation, production reliability, performance, and supported concurrency remain unproven. Do not replace unmeasured placeholders with configuration defaults or test durations.
