# Performance

`npm run benchmark` measures five cold core imports in fresh Node processes,
ten warmed validation batches and ten local provider batches. The input is a
3,400-byte synthetic text document with 100 TODO diagnostics per result. Run it
from a quiet checkout with the pinned development dependency installed.

The command reports runtime and gzip bytes, import heap delta, median import
time, median request-validation time and median local provider round-trip time.
Cold-import timing excludes process startup. Provider timing includes validation,
copying, lifecycle handling and range/identity checks in the local host.

These measurements exclude DDS adapters, transport, isolation, editor rendering
and production scheduling. They describe a reproducible local workload rather
than a service-level latency guarantee. `npm run pack:check` separately reports
the compressed/unpacked tarball sizes and integrity digest.

The core has zero runtime dependencies and does not import JSON Schema objects.
Load the `schemas` subpath when schema metadata is needed. Requests are capped
at one active document, providers/results are bounded, and cancellation releases
host pending slots even when the provider ignores its signal.

## Local reference measurement

Measured on 2026-10-03 with Node 22.23.1, Windows x64 and the workload above:

| Measurement | Observed value |
| --- | --- |
| Core ESM source, including transitive runtime modules | 18,297 bytes |
| Core source gzip | 5,019 bytes |
| Cold import median, five fresh processes | 4.67 ms |
| Import heap delta median | 487,504 bytes |
| Request validation median of ten 5,000-call batch means | 0.0152 ms/call |
| Local 100-diagnostic round-trip median of ten 100-call batch means | 1.23 ms/call |

Run the command again to compare your machine and changes. Heap delta and timing
vary with the runtime and concurrent work; these values are observations, not
performance thresholds or DDS product measurements.
