# 1.0 release candidate acceptance

Candidate: **1.0.0-rc.1**. This document records the acceptance scope; exact release
asset digests and final verification receipts accompany the GitHub release. An
unpublished checkout is not a release receipt.

Security audit and vulnerability validation are **pending** under the owner's
2026-10-05 deferral (DDS-243). Existing review records are retained. Functional,
compatibility and performance acceptance can continue, but none of those results
constitutes completed security acceptance. This candidate must not be described
as having passed the deferred audit.

## Reproducible checks

`npm ci --ignore-scripts` and `npm run check` cover the reviewed package allowlist,
API inventory, schemas, runtime tests, TypeScript declarations, standalone examples
and real `npm pack` installations outside this repository. The conformance example
reports all 18 SDK profiles; the browser example reports its available profiles and
explicitly marks Node paths unsupported. Every generated template has separate
runtime, type, generation, doctor and pack/verify acceptance.

The combined workload runs actual HTTP/filesystem/storage/upload/watch/edit paths
concurrently with language and settings requests. Per three-cycle sample it uses
131089-byte binary fixtures, 120 language requests, 120 commands, six verified
transfers and three observed project changes. It restarts the workspace host,
rejects old result generations and verifies one retained job instead of re-execution.
Fault mode also tests connection interruption, malformed responses, mid-transfer
upload revocation and host grant revocation. Five repeated fault cycles run in CI.

Existing integration fixtures cover killed child processes, durable checkpoint and
edit-journal recovery, corrupt records/chunks, failed/quota-limited writes, event
storms, expiration and ignored cancellation. These remain part of the full test
suite; memory/fake-clock tests are not substituted for their filesystem/process
evidence. Actual historical public archives are tested in both client/host
directions for their common contracts before release.

## Measurement and regression policy

`npm run benchmark:combined` launches five fresh child processes and reports
median, median absolute deviation, minimum and maximum for cold module import,
workspace setup, combined elapsed/CPU time, sampled process RSS/heap, watch latency,
logical disk I/O and HTTP JSON payload bytes. It tracks instrumented file handles
and compares active Node resource types before/after owned fixture cleanup. The
SDK host, queue, settings and diagnostics also check their own pending counters.
This is bounded fixture evidence, not whole-process leak detection or a latency SLA.

Logical disk counters wrap this benchmark child's `fs.promises` calls before SDK
imports; they count successful API payload reads/writes and renames. They exclude
physical drive traffic and cache behavior. Network counters include actual JSON
request/response bodies, excluding TCP/HTTP header overhead. RSS/heap are process
samples every 5 ms, not exact peak allocation. Each result records OS/architecture,
Node patch version, payload size and concurrency.

The checked-in performance baseline records its source run and measured spread for
each Windows/Linux × Node 22/24 profile. Thresholds compare five-sample medians to
`observed maximum + max(6 × MAD, 2 × observed range, observed maximum)`; this allows
at least one observed-maximum worth of scheduling variation and is a coarse guard
against large regressions. Resource residuals must be zero regardless of timing.
Calibration is an explicit setup action and never silently replaces a baseline.

## Boundaries and release gate

Required release evidence includes the exact PR/main commit and four required CI
jobs, the public SDK tarball plus SHA256SUMS, fresh download/hash/install and legacy
archive interoperability, browser profile evidence and EN/KO CMS/public readback.
The SDK is not accepted as GA until that evidence is present and blocking defects
are resolved. A candidate is published with GitHub's prerelease flag.

Known limits: trusted plugins and adapters run with ambient process authority;
browser storage support is conditional and OPFS recovery remains experimental;
file/edit operations have per-file atomicity and readback-only recovery; diagnostics
are local and owner-scoped; digests do not authenticate a publisher. No DDS UI,
Engine, Cloud, Marketplace, registry publication or Windows installer acceptance
is asserted. See [support policy](SUPPORT_POLICY.md) and [security](../SECURITY.md).
