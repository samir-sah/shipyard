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

## Limited local browser check

On November 3, 2026, the in-app browser loaded the actual Vite dashboard on Windows at `http://127.0.0.1:5173/`. A temporary localhost process invoked the existing `createApp()` with the repository's public test-only authentication fixture. Normal startup migrations/readiness were bypassed for this check because Docker Desktop again failed before starting its Linux engine with `sailor-ingest.sock: The file cannot be accessed by the system.` No private operator key was used, no backing service was simulated and no project was created.

Observed through actual browser interactions: an invalid key displayed `Invalid operator key`; a valid test key opened the dashboard; the signed session survived reload; a non-GitHub repository displayed the API validation error; unavailable backing services produced a project-load error; logout returned to sign-in and remained signed out after reload. Forms and controls were visually inspected in the narrow default browser viewport. Saved screenshots show [sign-in after logout](evidence/browser-signin-2026-11-03.jpg) and [the dashboard during the intentional backing-service outage](evidence/browser-outage-2026-11-03.jpg). These are manual observations, not automated browser regression tests. The temporary browser tab and both local test servers were closed afterward.

Successful project/history/log/restore interactions and the deployed site's JavaScript were not exercised in this local browser check. The public Git-to-site evidence above remains the CI HTTP/checksum smoke. Production DNS/TLS/proxy and sustained capacity remain unverified.

## Five-request benchmark bursts

[Manual CI run 41690912612](https://github.com/samir-sah/shipyard/actions/runs/41690912612) passed at `5ceed5f4f964c0a91cdcf08d248f4628214e3c93` on November 3, 2026. It passed 39 unit tests, 40 integration tests, the public smoke, and both benchmark configurations. Each configuration completed a separate baseline, warmup and five measured deployments. All fourteen benchmark builds succeeded in one attempt; the measured ten created ten active selections. Every published file matched its size/SHA-256 and every deployment matched the reviewed fixture SHA.

| Observed metric | Concurrency 1 | Concurrency 2 |
| --- | --- | --- |
| Measured successful deployments | 5/5 | 5/5 |
| Terminal failures / failed attempts / expired attempts / retries | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Active pointer changes | 5 | 5 |
| Maximum simultaneous ledger claims | 1 | 2 |
| Baseline elapsed after claim, s | 31.674 | 27.834 |
| Warmup elapsed after claim, s | 26.151 | 28.648 |
| Five-request submission window, ms | 23.529 | 45.240 |
| Measured burst window, s | 138.583 | 77.448 |
| Successful deployments/minute in that window | 2.165 | 3.874 |
| Active pointer changes/minute in that window | 2.165 | 3.874 |
| First queue wait median / p95, s | 56.970 / 110.612 | 25.144 / 49.074 |
| Elapsed after first claim median / p95, s | 27.952 / 33.373 | 27.423 / 28.959 |
| Creation-to-finish median / p95, s | 79.928 / 138.564 | 49.077 / 77.412 |

Durable raw evidence: [concurrency 1](evidence/benchmark-1-2026-11-03.json) and [concurrency 2](evidence/benchmark-2-2026-11-03.json). Rows retain original deployment/attempt timestamps and exact millisecond values. The fixture emitted 35 files / 3,282,526 bytes each time. Its package-lock SHA-256 was `7ba1980db760e6f99cb1f3ae1d50fb7a35981d1251d80515a3202e2b072eb88f`.

Both configurations ran sequentially on the same Intel Xeon Platinum 8573C runner with four allocated logical CPUs and 16,759,304,192 bytes RAM. Docker reported the same CPU/RAM allocation. Runtime versions were Linux `7.0.0-1017-azure`, host Node `v24.22.1`, builder Node `v24.22.2`, builder npm `11.19.1`, Docker `28.0.4` and Compose `2.38.2`. The filesystem capacity was 154,894,188,544 bytes; free space after the respective runs was 89,728,081,920 and 89,688,391,680 bytes. Disk medium and network bandwidth were not measured.

Each configuration used one worker process, with each build limited to 1 CPU, 512 MiB, 128 PIDs and 300 seconds. Lease duration was 30 seconds and the attempt limit three. Submission used one configured operator via bearer API requests, with one new project/deployment per request. Retention was disabled; HTTPS was absent. The measured burst excluded its baseline/warmup. Every attempt had fresh work/npm storage, while image layers were already warm and network/registry/storage caches and host activity were uncontrolled. The API, database, Redis, SeaweedFS and worker maintenance shared the runner.

Completion rate divides successful measured deployments by earliest measured creation to latest terminal finish in PostgreSQL. Later artifact verification/report writing is outside that window. Five samples make nearest-rank p95 equal to the observed maximum. The recorded claim overlap uses millisecond ledger timestamps; Docker overlap and CPU/RAM peaks were not sampled. The sequential configurations and uncontrolled caches do not establish a controlled speedup or sustained capacity. Failure/recovery timing and restore/webhook/retention latency remain unmeasured. Reproduction and the broader workload are in [BENCHMARK.md](BENCHMARK.md).

A measured portfolio statement is:

> Completed 10/10 public Vite deployments across two five-request CI bursts at worker concurrency 1 and 2, observing 2.16 and 3.87 completions/minute respectively under per-build 1 CPU / 512 MiB limits, with no retries and all served artifacts verified by SHA-256.

## HTTPS proxy verification

[CI run 41694725753](https://github.com/samir-sah/shipyard/actions/runs/41694725753) passed at `b3a8e7a98bd5bd76fdf52a21583a0669c45e0a8c` on November 3, 2026 UTC. It passed the normal checks, all 39 unit and 40 integration tests, the real public deployment smoke, and `scripts/proxy-demo.ts`. The proxy used Nginx `1.30.6-alpine` with the image digest saved in the [sanitized JSON report](evidence/proxy-demo-2026-11-03.json). This durable copy matches the report printed in the successful CI logs; the downloadable `proxy-demo` artifact is retained seven days.

The runner mounted the checked-in Nginx example with only its upstream address changed to `api:3000`. It generated an ephemeral private test CA and a leaf certificate covering the dashboard and wildcard site names. The CA private key was not mounted into Nginx; no OS/browser trust settings were changed. The client explicitly trusted that CA, sent the required SNI/Host, and negotiated TLS 1.3 on loopback port 8443.

Actual passing assertions covered `nginx -t`, HTTPS health, rejection of an untrusted CA and a wrong SAN, the Secure/HttpOnly/SameSite=Strict/host-only `__Host-shipyard_session` response, cookie-authenticated management, cross-origin mutation rejection, site-host API isolation, unknown-host connection rejection, and logout cookie clearing. Both pinned HTTPS serving routes matched every size/SHA-256 for 35 files / 3,282,526 bytes from reviewed fixture commit `cfda8c5841b6e57f644f19aa10c4329553162a15`. The API's previous origins were restored and the test proxy/container/private keys removed before the successful step completed.

The first proxy run failed its logout assertion because the test client's DELETE body omitted explicit HTTP framing. Adding the JSON `Content-Length` fixed the test client; product code and Nginx configuration did not change. Logout evidence concerns clearing the client cookie, not revoking a copied stateless cookie. A raw HTTPS client does not prove browser cookie/SameSite enforcement or deployed JavaScript behavior. This was a private-CA loopback test, with public DNS, public issuance/renewal, public ingress, TLS capacity and production operation still unverified.

## Local runtime follow-up

Docker Desktop's inaccessible stale runtime endpoints were preserved by renaming its `run` directory to `run.shipyard-stale-20261103-235447` under its existing local data parent, after stopping only the failed processes started for these checks. A normal start then exposed Linux Engine `29.7.2`. No images, settings, data disks or volumes were deleted to recover startup.

The attempted local bootstrap pulled development images and started backing services, but the image build hit a Go `SIGBUS` and Docker stopped responding. Host checks confirmed `C:` had **0 free bytes**, while workspace drive `S:` had about 80 GB free. Docker's data VHDX was about 11.52 GB on `C:`. Disk exhaustion is a plausible explanation for the crash; no filesystem-corruption diagnosis is established. Free space should have been checked on the actual Docker data drive before starting image pulls.

The build/diagnostic commands were canceled. The Docker processes started for the check were stopped and only the `docker-desktop` WSL distribution was returned to its previously stopped state. Images, disks and development volumes remain preserved; Docker data was not relocated. The local successful project/site browser flow therefore remains unverified pending space recovery or an approved data relocation. The earlier limited browser observations and passing CI evidence remain as recorded above.
