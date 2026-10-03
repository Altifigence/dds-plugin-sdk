# Changelog

## 0.1.0 — 2026-10-03

- Introduce protocol 1 diagnostics manifests, immutable bounded request/result
  parsers, TypeScript declarations and JSON Schema 2020-12 files.
- Add explicit diagnostic grants, deterministic provider registration, cancellation,
  timeout, stale-response checks and idempotent disposal.
- Add a local test host and an executable Hello Diagnostics plugin.
- Verify public tarball consumers outside the source tree, including ESM imports,
  the example and TypeScript declarations.

This release supports local plugin authoring. DDS production plugin loading
is not included.
