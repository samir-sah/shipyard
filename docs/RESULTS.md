# Verified deployment smoke

On November 3, 2026, [CI run 41685329438](https://github.com/samir-sah/shipyard/actions/runs/41685329438) passed at platform commit `607858b23e5e5c50af1f011558226f157478fb47`. It ran a real public Git checkout through the fixed Docker recipe, not a prepared-output builder. The API, worker, PostgreSQL, Redis and SeaweedFS ran in disposable Compose services. The site was discarded after the run; this is not a currently hosted public demo.

The reviewed [fixture commit](https://github.com/adrianhajdin/nike_landing_page/tree/cfda8c5841b6e57f644f19aa10c4329553162a15) matched the deployed SHA. Its license/dependency limitations and reproduction command are in [DEMO.md](DEMO.md#automated-public-checkout-smoke). The original sanitized [JSON evidence](evidence/public-demo-2026-11-03.json) is committed here because CI artifact retention is seven days.

| Observation | Actual result |
| --- | --- |
| Deployment | `c65a89dc-7f56-480b-84ab-55d75467a2ca`, deployed and active |
| First queue wait | 11.151 ms |
| Elapsed after first claim (`buildDurationMs`) | 16,021.577 ms |
| Creation to terminal completion | Approximately 16.033 s from API timestamps |
| Attempts | 1 |
| Published output | 35 files, 3,282,526 bytes |
| Serving | All file sizes/SHA-256 matched through both immutable routes |
| Entry references | Static HTML asset references remained within each pinned version |
| Host boundaries | Project redirect/CSP and dashboard-host sandbox checked with explicit Host headers |
| CI checks | 37 unit and 40 PostgreSQL/Redis/S3/Docker integration tests passed; no skips |

One worker process ran at concurrency 1. Each build was limited to 1 CPU, 512 MiB RAM, 128 PIDs and 300 seconds, with a 30-second lease and maximum three attempts. The runner exposed four logical CPUs and 16,760,348,672 bytes RAM; its CPU model was AMD EPYC 9V74 80-Core Processor. The model name is not its allocated core count. Ubuntu 24.04 runner labels reported Linux `7.0.0-1017-azure`, host Node `v24.22.1`, builder Node `v24.22.2`, Docker `28.0.4` and Compose `2.38.2`.

There were no warmups or repeated samples. The work volume and npm cache were fresh per attempt; Docker image layers were already built. Network, registry and storage caches were uncontrolled. Elapsed time includes checkout, installation, build, validation/upload and orchestration; it is not isolated Vite execution time. Duplicate enqueue calls were made, while deterministic tests separately verified actual duplicate delivery/claims. Existing suites also passed failed-build preservation, out-of-order completion, rollback overlapping a build, and killed-worker upload recovery using prepared output with real persistence/storage.

This one-run functional result establishes the supported recipe on this runner under the stated limits. It does not establish sustained throughput, p95 latency, supported aggregate concurrency or hostile-code isolation. Browser JavaScript execution/layout, wildcard DNS and a real HTTPS/reverse-proxy deployment remain unchecked. [BENCHMARK.md](BENCHMARK.md) retains the unmeasured workload/template for those measurements.

A verified portfolio statement is:

> Built a TypeScript Git-to-static-site platform with PostgreSQL publication guards, immutable S3 artifacts, worker leases, retries and rollback. Verified a public Vite checkout/build/deployment in CI under 1 CPU and 512 MiB limits, with every served artifact checked by SHA-256.
