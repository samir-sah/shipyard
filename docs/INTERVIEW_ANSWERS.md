# Shipyard: 100 interview questions and answers

These are study answers for the questions in [STUDY_GUIDE.md](STUDY_GUIDE.md). They describe Shipyard as implemented and verified at commit `4312e05`. Use them to understand the design, then explain your own contribution and any assistance honestly. Examples identify observed behavior; proposed improvements are labeled as proposals.

## Basic: project and web fundamentals

### 1. What problem does Shipyard solve?

Shipyard automates taking a supported public GitHub repository and publishing its built static files as a site. Instead of manually cloning, installing, building, copying and configuring each version, an operator submits the repository and follows deployment status in a dashboard. Shipyard also keeps version history and supports restoring an earlier successful build.

### 2. Who is the intended user of Shipyard?

It is intended for configured operators who control the installation and deploy repositories they trust. The current implementation is a self-hosted portfolio system, not an open public hosting service for arbitrary untrusted users. Each operator manages only their own projects.

### 3. What is the difference between Shipyard and a repository it deploys?

Shipyard is the platform that performs builds and serves the results. A submitted repository is input to that platform: it contains the source for a separate website. For example, the Nike/Vite repository used in the local demo was a test input, while Shipyard's own source is in `samir-sah/shipyard`.

### 4. What is a static website?

A static website is delivered as files such as HTML, CSS, JavaScript and images. The browser can execute its JavaScript and make API requests, but Shipyard's serving process only needs to return those built files. Static does not mean the page cannot be interactive.

### 5. How does a static website differ from a backend application?

A backend application runs server-side code to process requests, perform computations or access data. A static deployment serves prebuilt files; any interactive logic runs in the browser or calls a separate API. Shipyard hosts static build output, not arbitrary user backend processes.

### 6. What is Git, and why does Shipyard clone a repository?

Git is a version-control system that tracks source changes and revisions. Shipyard clones a repository so a temporary build container can obtain its source and build it. It currently accepts a public HTTPS GitHub repository and normally builds its `main` branch.

### 7. What does a Git commit SHA identify?

A commit SHA identifies a Git commit and therefore a particular repository revision and its history. Shipyard records the built SHA so an operator can see which revision produced a deployment. For manual builds, that SHA is pinned after the first Docker build finishes, leaving a crash-before-pin window.

### 8. What is the purpose of `package-lock.json`?

The lockfile records the dependency tree and resolved package versions so installs can reproduce the intended dependency selection. Shipyard's supported recipe requires a root `package-lock.json`, which `npm ci` uses. It improves repeatability but cannot guarantee every external registry or build environment remains unchanged forever.

### 9. What does `npm ci` do in this workflow?

Inside the builder, `npm ci` installs dependencies according to the lockfile for a clean build. It expects the package manifest and lockfile to be consistent. Package installation may execute scripts, which is one reason Shipyard only accepts trusted repositories.

### 10. What does Vite produce during the build?

Vite transforms the application source and produces browser-ready output, usually HTML plus bundled JavaScript, CSS and assets. This project's supported recipe expects that output under `dist/`, including `dist/index.html`. Shipyard uploads the output files, not the original source repository.

### 11. Why does the build use `--base=./`?

It asks Vite to generate relative asset references so files can load under a version-specific URL rather than assuming the domain root. That matters because Shipyard serves versions under paths such as `/_shipyard/v/<deployment-id>/`. An application with hard-coded absolute paths or a history router may still require additional configuration.

### 12. What is an API, and why does the dashboard use one?

An API is an interface through which one program requests operations or data from another. The React dashboard calls the Express API to sign in, create projects, request deployments and read history and logs. The API applies validation, authentication and ownership checks before working with the backend services.

### 13. What does the React dashboard show an operator?

It shows owned projects, their deployment history, status, queue wait, elapsed build time and build logs. It provides actions to deploy, open a version, restore it, mark it Keep and configure a webhook. It polls for updates; the browser does not run the Docker build itself.

### 14. What is the difference between a project and a deployment?

A project is the persistent record for a repository and its owner, including which deployment is currently active. A deployment is one build request and its resulting status, logs, attempts and, if successful, artifacts. One project can have many deployments.

### 15. What do queued, building, deployed and failed mean?

`queued` means a deployment is waiting for a worker claim. `building` means an attempt has been claimed and is in progress. `deployed` means a successful artifact version was recorded; `failed` means the deployment reached a terminal failure, such as after exhausting its attempts.

### 16. What does the LIVE label mean?

LIVE identifies the deployment selected by the project's active pointer in PostgreSQL. The stable project URL redirects visitors to that version. LIVE describes the active selection, not merely whether a build succeeded.

### 17. How can a deployment be deployed but not LIVE?

A successful build can finish after a newer request has advanced the project's generation, so it remains available in history without becoming active. A previously live version also remains deployed after another version is selected. Its Version link can still open it while its artifacts remain available.

### 18. What does the Version link do?

It opens a particular successful deployment's immutable version URL. This lets an operator inspect an older or superseded successful version without changing the project's active pointer. The link remains usable only while the artifacts are available.

### 19. What does Restore do?

Restore selects an existing successful version without rebuilding it. Before changing the active pointer, Shipyard checks the stored completion manifest and re-verifies the listed objects; then a guarded transaction advances the generation and selects the target. A restore also prevents earlier pending builds from later replacing it.

### 20. What does Keep protect?

Keep marks a successful version for protection from automatic retention deletion. Active versions and a configured set of newest successful versions have separate protections. Retention is disabled by default, and Keep is not a substitute for an external backup.

## Intermediate: components and deployment flow

### 21. What happens from clicking Create & deploy to opening a site?

The API authenticates the operator, validates the project and creates a queued deployment in PostgreSQL. A worker claims the job, builds the repository in Docker, validates and uploads the output, and records the successful version under database guards. When a visitor opens the stable project URL, Shipyard redirects to the active immutable version and serves its files from object storage.

### 22. Why is the build performed by a worker instead of the API request?

A build can take minutes or fail and retry, while an HTTP request should return promptly. A worker processes the queued deployment independently, lets the dashboard poll for progress and supports recovery after interruptions. This separation adds queue and coordination complexity, which PostgreSQL guards address.

### 23. What is a background job queue?

It is a mechanism for scheduling work to be processed asynchronously by another process. The producer can enqueue a job and respond without waiting for the job to finish. Jobs can be delivered more than once or need recovery, so consumers must protect important state transitions.

### 24. What roles do Redis and BullMQ play?

Redis holds queue-related data, and BullMQ provides the scheduling and delivery machinery. Shipyard uses job IDs based on the deployment ID and expected attempt. PostgreSQL remains authoritative about whether an attempt is eligible and who may publish.

### 25. Why is PostgreSQL still necessary when Redis stores jobs?

Queue state alone does not provide Shipyard's durable project history, ownership, publication ordering or worker-claim rules. PostgreSQL transactions and row locks protect those records and the active pointer. The dispatcher can reconstruct ready queue work from database state if enqueueing or delivery is lost.

### 26. Which data belongs in PostgreSQL and which belongs in object storage?

PostgreSQL stores project and deployment metadata, ownership, status, logs, attempts, generation and the manifest selected for a successful deployment. Object storage holds the actual HTML, CSS, JavaScript, images and completion manifest under version/attempt prefixes. The database selects which stored version is active.

### 27. What does S3-compatible mean? Is SeaweedFS Amazon S3?

S3-compatible means the storage service supports the S3 API operations the application uses; compatibility does not imply every implementation has identical guarantees. SeaweedFS is a separate storage product, not Amazon S3. The local Compose setup uses SeaweedFS to provide the S3-compatible endpoint.

### 28. What is a Docker image, and how does it differ from a container?

An image is a packaged filesystem and configuration used as a template. A container is a running or stopped instance created from an image. Shipyard has a builder image and creates a separate temporary build container for each attempt.

### 29. Why does each build use a separate container and work volume?

Separate resources reduce accidental interference between attempts and make cleanup and ownership identifiable. Each attempt uses a unique token in its container and volume names and labels. Container separation and limits are useful controls, but they do not establish safe isolation from malicious code.

### 30. What are the configured CPU, memory, PID and time limits?

The defaults are one CPU, 512 MiB memory, 128 PIDs and a 300-second build timeout per attempt, with worker concurrency one. They are configuration defaults, not proof of supported aggregate capacity. Total deployment time can be longer because of retries, backoff, downtime and cleanup.

### 31. Why must `dist/index.html` exist?

The fixed recipe expects a static site entry document at that path. Requiring it prevents Shipyard from recording a nominally successful version with no entry page. It does not prove that every client-side route or feature in the built application works.

### 32. How are deployment logs displayed and updated?

The worker records bounded log entries for a deployment, and the dashboard requests additional entries using a cursor. It polls for updates every two seconds in the current interface. Logs provide useful progress and errors, but repository-generated output can itself contain sensitive text.

### 33. How does the platform calculate queue wait?

`queueWaitMs` is the time from deployment creation to its first worker claim. It is not the sum of every later retry wait. That distinction matters when comparing a clean first attempt with a deployment that experiences retries.

### 34. What does `buildDurationMs` include besides the Vite build?

Despite its historical name, it measures elapsed time from the first claim until terminal completion. It includes checkout, installation, validation, artifact upload, cleanup and any retry backoff, later queue waits or worker downtime. It should not be described as isolated Vite compilation time.

### 35. Why are site artifacts stored under versioned paths?

Versioned paths keep one deployment's files separate from later deployments. They let the platform retain history, open an old version and restore it without rebuilding. Attempt-specific subpaths further isolate retries and stale workers within a deployment.

### 36. What is a stable project URL?

It is a consistent address for a project, such as `http://<slug>.sites.localhost:3000/` locally. The address remains the same when the selected deployment changes. Shipyard looks up the active deployment and redirects the request to that version.

### 37. Why does the stable URL redirect to a version-specific URL?

The redirect pins a page load to one deployment ID. If a new version becomes live while a browser is loading assets, the existing page's relative assets can continue loading from the original version rather than mixing releases. A later visit to the stable URL can select the new active version.

### 38. What happens if an asset path points outside its pinned version?

It can escape the version path and fail to load or resolve to an unintended route; the version-pinning benefit depends on correctly resolved relative assets. Shipyard requires the Vite `--base=./` recipe, but hard-coded absolute asset paths and router configuration still need application-specific attention. The public smoke checked that its fixture's entry references stayed within the pinned version.

### 39. How does the platform handle a build that fails?

It records the failure and, while attempts remain, schedules a retry with bounded backoff. After the attempt limit it marks the deployment failed. A failed build does not replace an already active site; a newer failed request still prevents an older pending build from taking over under the latest-requested policy.

### 40. What happens to temporary build resources after an attempt?

The worker tries to remove the attempt's container, work volume and temporary workspace even when the attempt was canceled. A maintenance process later revisits labeled abandoned resources and failed or expired artifact prefixes. Cleanup is bounded and best effort, so it has no guaranteed fixed completion time under failures or backlog.

## Intermediate: data, security and operations

### 41. What is a database migration, and why are these migrations additive?

A migration is a versioned change to the database schema or its data. Shipyard's migrations add features such as publication generations, worker claims and ownership while preserving existing history and active selections. Additive changes reduce upgrade disruption, but they do not make mixed old/new workers or automatic downgrades safe.

### 42. What is a transaction, and where does Shipyard use one?

A transaction groups database changes so they commit together or roll back. Shipyard uses PostgreSQL transactions and locks when creating deployments, selecting active versions, restoring and coordinating retention. The transaction does not extend into S3, so artifact publication needs additional safeguards.

### 43. What is a primary key, and why use a UUID for a deployment?

A primary key uniquely identifies a row in a table. Shipyard uses a UUID as a stable deployment identifier across queue delivery, attempts, logs and version URLs. A UUID reduces identifier coordination and accidental collision, but an unguessable ID is not a replacement for authorization.

### 44. What is a session cookie, and what does HttpOnly provide?

A session cookie is browser-held data sent back with applicable requests to represent a session. Shipyard signs a session containing identity and expiry after a valid operator token is submitted. `HttpOnly` prevents ordinary page JavaScript from reading that cookie, though it does not by itself prevent every browser-based attack.

### 45. What do Secure, SameSite and host-only cookies mean?

`Secure` restricts sending the cookie to secure connections; Shipyard uses it for an HTTPS dashboard. `SameSite=Strict` limits when the browser sends it in cross-site contexts. A host-only cookie has no broad Domain attribute and is scoped to the host that set it; Shipyard also sets HttpOnly and path `/`.

### 46. How are projects associated with their owners?

Configured `AUTH_USERS` entries provide operator identities, and the project record stores an owner ID. Management queries and actions are scoped to the authenticated owner, including history, logs, restore and webhook configuration. Existing pre-ownership projects are assigned to the fixed bootstrap owner by migration.

### 47. Why should an operator key never be committed to Git?

Anyone who obtains a valid key can act as that operator through the management interface. Git history and remote copies can preserve a secret even after a later commit removes it. Store keys in private configuration, restrict access and rotate any key that may have leaked.

### 48. Why does the builder not receive platform secrets or the Docker socket?

The submitted repository can execute install and build scripts, so passing those resources into its container would unnecessarily expose privileged access to repository code. The worker keeps responsibility for Docker and storage operations. This reduces exposure but does not prove the builder is secure against hostile code.

### 49. What is the Docker socket, and why is access to it powerful?

The socket is an interface to the Docker daemon. A process with access can ask the daemon to create and control containers and related resources, effectively giving it powerful control over the Docker host. Shipyard's worker needs this access; build containers do not receive it.

### 50. Why is a public repository not automatically a trusted repository?

Public only means accessible; its code or dependencies could still be malicious or compromised. `npm ci` and the build command can execute scripts and make network requests. Shipyard's current limits are not a hardened sandbox, so the operator must decide which repositories to trust.

### 51. How does the API validate repository input?

It accepts the supported public HTTPS GitHub repository format and validates the project name and repository URL before creating records. The platform uses a fixed branch and build recipe rather than accepting arbitrary commands or output directories. Input validation narrows the attack surface but does not make repository code trustworthy.

### 52. Why are user-supplied shell commands outside the supported recipe?

Arbitrary commands would greatly expand what a submitted deployment can execute and complicate validation, reproducibility and security. Shipyard instead invokes the fixed build recipe using argument arrays rather than interpolating user values into shell commands. Even that fixed recipe executes repository-provided npm scripts, so trusted inputs remain necessary.

### 53. What are a hostname, a subdomain and DNS?

A hostname is a name used to identify a network service, such as `shipyard.example.com`. A subdomain is a name under another domain; Shipyard uses a project-specific subdomain for each site. DNS maps names to destinations so a browser can reach the server or proxy.

### 54. How does Shipyard choose a project from the HTTP Host header?

It reads and validates the raw Host header, checks whether it ends in the configured site base hostname and extracts a valid project slug. Site-host routes are restricted to read-only site access; management API and health routes are blocked there. Unknown hosts are rejected, and forwarded-host headers do not select projects.

### 55. Why should the dashboard and published sites use different origins?

A browser origin separates security-sensitive dashboard interactions from scripts running in published sites. Shipyard gives projects separate hosts and uses host-only management cookies; for public operation its documentation recommends a separate registrable site domain as an additional boundary. Versions of the same project still share that project's origin.

### 56. What additional role does Nginx play in a public installation?

Nginx can receive public HTTPS traffic, terminate TLS and forward requests to Shipyard while preserving the original Host header. It is an operational entry point in the example deployment, not the service that builds repositories. A public installation also needs correctly configured DNS, certificates, firewall rules and monitoring.

### 57. What is HTTPS and why does a public deployment need certificates?

HTTPS uses TLS to encrypt traffic and authenticate the server name to the client using a trusted certificate. Public Shipyard login sends an operator token and uses a secure session cookie, so a properly configured HTTPS endpoint is essential. The checked-in Nginx example expects the operator to supply certificates; public issuance and renewal have not been verified here.

### 58. What is a GitHub webhook?

A webhook is an HTTP request GitHub sends to a configured endpoint when a selected event occurs. A Shipyard operator can configure a project webhook so an accepted push to `main` creates a deployment pinned to the push SHA. The endpoint must be reachable by GitHub for public delivery.

### 59. Why does Shipyard verify the webhook signature before accepting a push?

The HMAC signature lets the receiver verify that the raw body was signed with the expected project secret and was not altered in transit. Shipyard verifies it before parsing and accepting a delivery, then checks the repository, ref and delivery ID. A signature does not prove that arrival order matches Git commit chronology.

### 60. What must be included in a consistent backup and why?

Back up PostgreSQL metadata, Redis persistence, S3-compatible object data and the private `.env`, with the application revision and schema version. The stores have different responsibilities: restoring only the database can leave active pointers to missing files, while restoring only artifacts can leave metadata absent. Quiesce writers and test a coordinated restore on separate storage or a separate host.

## Advanced: ordering, retries and reliability

### 61. What problem occurs if the same queue message is delivered twice?

Without guards, two workers might both build, write logs or race to publish the same deployment, wasting resources and risking incorrect state. Queue-level job IDs help reduce duplicates, but Shipyard also checks expected attempt, status and claim conditions in PostgreSQL. The database remains authoritative even if duplicate delivery occurs.

### 62. Does Shipyard promise exactly-once message delivery? What does it guarantee instead?

No. Delivery can be duplicated or need reconstruction. Shipyard instead uses conditional database claims, unique attempt tokens and publication guards so a duplicate or stale delivery cannot legitimately claim or publish through those protected state transitions.

### 63. What conditions must a worker satisfy to claim an attempt?

The deployment must be in the appropriate queued state, ready for retry, within its attempt limit and match the expected attempt carried by the job. A successful claim atomically moves it to building and creates an attempt token and lease. The checks are enforced in PostgreSQL rather than relying only on queue deduplication.

### 64. What is a lease, and why does it need renewal?

A lease is a claim valid until a recorded expiry time. Shipyard's default lease is 30 seconds, and its worker renews it approximately every 10 seconds while it owns the attempt. Renewal signals continued ownership; if the worker stops renewing, recovery can eventually schedule a replacement.

### 65. What happens when a worker crashes while holding a lease?

Its heartbeat stops, so the claim eventually expires. A periodic recovery scan marks the old attempt expired and either requeues the deployment with backoff or fails it if the attempt limit is exhausted. Temporary resources or unselected artifacts can remain until cleanup; the stale claim cannot publish.

### 66. What is a fencing token and which operations check it?

A fencing token distinguishes the current owner of an attempt from previous owners. Shipyard checks the matching token and unexpired lease for renewal, attempt logs, commit pinning, failure transitions and publication. An old process can still exist, but PostgreSQL rejects its protected updates once its claim is stale.

### 67. Why is a timeout alone insufficient to stop a stale worker publishing?

A process can pause, lose connectivity or continue running after another worker has taken over. Merely deciding that time has elapsed does not guarantee that the old process has stopped. Fencing makes the database check current ownership when a state-changing operation is attempted.

### 68. What happens when a worker loses its lease during upload?

Lease cancellation is propagated to build and upload work, and the stale token cannot complete the guarded publication transaction. The attempt may already have written partial objects in its own prefix. Those unselected objects are eligible for later best-effort cleanup; they are not the active version.

### 69. How do bounded retries and exponential backoff work here?

The default maximum is three total attempts. After a builder or upload error, or an expired claim, an eligible deployment can return to queued with a delay starting at one second and increasing exponentially, capped at 60 seconds. The retry limit prevents endless attempts, although deterministic errors still consume the configured attempts.

### 70. What happens when the maximum attempt count is reached?

The deployment becomes terminally `failed` rather than being requeued indefinitely. Its history and logs remain available, and the existing active site is preserved. A later deployment request is a separate deployment with its own ID and attempt history.

### 71. How is ready work recovered if queue delivery is lost?

PostgreSQL retains queued deployment state independently of Redis job records. A dispatcher periodically scans for ready work and can reconstruct the appropriate expected-attempt job. Database claim conditions still prevent a duplicate delivery from taking ownership incorrectly.

### 72. How can an orphaned build container overlap a retry?

If a worker dies or loses its lease, its Docker container may continue until its autonomous timeout or cleanup removes it. Recovery can start a replacement attempt before that happens. Therefore a per-worker concurrency setting is not a strict cap on all containers running on the machine during failures.

### 73. What is a publication generation?

It is a per-project ordering value advanced when a deployment is requested or a restore is committed. A successful build may update the active pointer only if its recorded generation is still current. The generation orders publication decisions independently of a worker's claim token.

### 74. How do latest-requested-build semantics work when A and B overlap?

If A starts and B is requested afterward, B receives the newer generation. A may still finish successfully and be stored, but it cannot activate after B's request because A's generation is older. This defines a predictable policy even when completion order differs from request order.

### 75. What happens if B is requested after A but B fails before A succeeds?

The previously active version stays live. A's later successful result can be retained in history, but B's newer request already advanced the generation and prevents A from activating. This is latest-requested semantics, not latest-successful-completion semantics.

### 76. How does a restore interact with an already running build?

After validating the target artifacts, restore advances the project's generation and selects that version in a guarded transaction. A build requested before that restore may finish and remain in history, but its older generation cannot undo the restore. A newly requested build after the restore can become active if it succeeds and remains current.

### 77. Why does project-row locking matter for restore and activation?

The lock serializes changes to the project's generation and active pointer. A racing build completion and restore therefore have a defined database commit order: one either activates before restore and is replaced, or sees the newer generation and stays in history. Retention uses compatible locking to coordinate with restore and Keep.

### 78. Why is HTTP arrival time not the source of ordering truth?

Concurrent requests can be delayed or reach different database operations at different times, so arrival is not a reliable serialization boundary. Shipyard defines ordering through committed PostgreSQL project-row lock operations. A restore can also spend time validating objects before it acquires its final transaction lock.

### 79. What does idempotency mean for a GitHub delivery ID?

If the same delivery ID is received again with the same event and payload, Shipyard returns the previously recorded result rather than creating another deployment. Reusing that ID with conflicting event or body data is rejected. The delivery record and any resulting deployment are inserted atomically in PostgreSQL.

### 80. Why can webhook acceptance order differ from Git commit chronology?

Network delays and retries can cause an older push event to arrive after a newer one. Shipyard orders publication by the accepted project transaction, not by an independent check of GitHub's newest head. Consequently, a late older push can receive a newer generation; operators should inspect deliveries and history when diagnosing that case.

## Hard: integrity, trade-offs and design critique

### 81. Why verify uploaded object sizes and SHA-256 hashes?

The worker compares the actual uploaded object bytes against the expected sizes and hashes to detect missing, truncated or changed data before publication. The manifest records the values for later validation, including restore checks. Hash verification supports integrity; it does not prove the source code is safe or that compiled files contain no secrets.

### 82. What is the completion manifest, and why is it written last?

It is a record of the deployment/attempt identity and the successfully validated files, sizes, hashes and total bytes. Writing it after uploads and verification provides a completion marker for that attempt. PostgreSQL still decides which manifest and deployment are selected; the marker alone does not activate a site.

### 83. Can a crash leave complete or partial objects without a database-selected version?

Yes. There is no single transaction across PostgreSQL and object storage, so a crash can occur after some or all uploads but before the database commits publication. Those objects are not automatically active; bounded maintenance can revisit unused failed or expired attempt prefixes.

### 84. Why are attempt-specific object prefixes important after lease loss?

Each attempt writes under a prefix containing its token, so a stale attempt and its replacement do not overwrite the same artifact keys. The database-selected manifest identifies the successful attempt's prefix. Stale writes can still leave garbage, but fencing prevents the old token from selecting that garbage as the published result.

### 85. Why is there no single atomic transaction spanning PostgreSQL and S3?

They are separate systems with separate commit mechanisms, and Shipyard does not implement a distributed transaction coordinator. Instead it uploads and verifies immutable objects, writes a completion marker, then uses a guarded PostgreSQL transaction to record and optionally activate the version. This design tolerates unused objects that require cleanup.

### 86. What happens if a rollback target's manifest or object is missing or changed?

Restore compares the completion marker with the saved manifest and reads the listed objects to check their sizes and hashes. If validation fails, it rejects the restore and leaves the active pointer unchanged. The operator must repair storage, recover from backup or rebuild rather than bypassing the integrity checks.

### 87. How does retention avoid racing with Keep or restore?

Retention, Keep and restore coordinate using the same project-first database lock order and recheck artifact availability. Retention claims an eligible version by moving it from `available` to `deleting` before removing objects. Once claimed, Keep and restore reject that unavailable target rather than racing it back into use.

### 88. Why can a deletion already marked `deleting` continue after retention is disabled?

The claim has already crossed the point at which some objects may have been removed. Disabling retention stops new claims, but existing deletion jobs must resume and finish consistently, including after a crash. There is no built-in undelete; recover from backup or rebuild if necessary.

### 89. What does the legacy artifact compatibility path guarantee, and what can it not detect?

For an older successful version without a database manifest, restore can discover its legacy prefix, validate the available objects against their recorded metadata and seal a manifest. Milestone 1 did not record a complete file list, so discovery cannot detect an asset that was deleted before discovery if the remaining files and index still validate. Rebuilding gives the newer full-manifest completeness behavior.

### 90. Why must old and new API/worker versions not overlap during a migration?

Older processes may not enforce the current generation, lease-token, attempt-prefix or ownership rules. Running them alongside newer processes could bypass the protections expected by the new version. Stop both API and worker for a coordinated upgrade, preserve the data volumes and follow the documented backup/compatibility plan.

### 91. What are the security limits of CPU, memory and PID restrictions?

They bound certain resource consumption for an individual container, but they do not prevent malicious network activity, guarantee kernel isolation or impose checkout/npm disk and queue-growth quotas. The worker itself controls the Docker host through its socket. Treat the current builder as suitable for trusted repositories on a dedicated host, not a proven hostile-code sandbox.

### 92. How would you isolate genuinely untrusted builds more strongly?

As a proposed improvement, use short-lived VMs or microVMs with a stronger boundary, narrowly scoped credentials, restricted network egress and explicit disk/time/resource quotas. Separate the build environment from the control plane and monitor or destroy it after each attempt. Validate the design with adversarial tests, failure injection and independent security review; Shipyard does not currently provide this guarantee.

### 93. What can go wrong if npm install scripts or build output contain secrets?

Install or build scripts may print sensitive values into logs or embed them in generated JavaScript and other published files. Published artifacts are public, and Shipyard cannot reliably detect arbitrary secrets embedded inside compiled output or logs. Avoid exposing platform credentials to builds, use trusted repositories and review or rotate any exposed secret.

### 94. Why does pinning a manual build after its first completed Docker build leave a crash-before-pin window?

Before the first build completes and its SHA is recorded, a crash can cause a retry to resolve `main` again. If `main` has advanced, the retry may build a newer commit. Once the first completed build's SHA is pinned, subsequent attempts fetch and verify that recorded revision.

### 95. How do webhook-pinned SHAs differ from manual-build SHA pinning?

An accepted signed webhook records the push payload's SHA when it creates the deployment, so its attempts target that accepted revision from the start. A manual deployment resolves and records a SHA after its first completed Docker build. The manual path therefore has the crash-before-pin window described above.

### 96. What is measured by the two five-request benchmark bursts, and what remains unknown?

The recorded CI comparison submitted five measured deployments at worker concurrency one and five at concurrency two, after separate baseline and warmup builds. All ten measured deployments succeeded, with observed finite-window rates of 2.165 and 3.874 completions per minute and no retries; file sizes and hashes were checked. The samples do not establish sustained capacity, causal speedup, peak resource use or production reliability.

### 97. Why is a five-sample p95 not a reliable production capacity estimate?

Five observations are too few to characterize a variable latency distribution, and the nearest-rank p95 for five samples is simply the largest observed value. Results also depend on workload, machine limits, network, caches and other activity. More representative and repeated measurements are needed before making a capacity claim.

### 98. What would a sustained-load experiment need to measure beyond configured concurrency?

Record the hardware and runtime, workload and fixture SHA, arrival rate, duration, queue depth, warmups and cache conditions. Measure successful completions separately from terminal failures, failed or expired attempts, retries and active-pointer changes; capture queue/end-to-end distributions, observed container overlap and CPU, memory, disk and network usage. Include recovery behavior and state the precise conditions under which the results apply.

### 99. How would you test recovery after a crash during artifact upload without risking production data?

Use disposable infrastructure or isolated test schemas and storage prefixes with controlled fixtures. Pause a worker at a known upload boundary, terminate it, then verify lease expiry, a new claim, stale-token rejection, artifact selection and eventual cleanup without manually changing production state. Shipyard's integration harness exercises killed-child recovery with real PostgreSQL and object storage but a prepared fixture builder; it is not a full public Git crash benchmark.

### 100. If asked to make Shipyard production-ready, which three limitations would you prioritize and how would you validate each fix?

One defensible answer is: **(1) build isolation and quotas**, using a stronger execution boundary, egress controls and disk/queue limits, validated with adversarial and resource-exhaustion tests; **(2) recovery and operations**, using consistent backups, monitoring and tested restore procedures, validated by isolated disaster-recovery drills; and **(3) measured capacity and public ingress**, validating sustained workload behavior, DNS, real certificates, browser sessions and failure recovery under documented limits. These are proposed improvements and tests, not claims that the current project already has production guarantees.
