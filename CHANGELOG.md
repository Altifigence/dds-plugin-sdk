# Changelog

## 0.2.0 — 2026-10-03

- Keep manifest v1 and diagnostics compatible; add manifest v2 with UI/workspace
  runtime declarations, commands, source visibility and license expressions.
- Add portable workspace read/list/CAS write and named backend APIs with explicit
  grants, bounded JSON, cancellation and plugin disposal.
- Add a user-owned Node workspace server and client: scoped project files,
  revision checks, plugin artifact identity, authenticated transport and fixed
  process backends. Remote clients cannot install modules or submit shell code.
- Add Hello Ocean theme validation, DDS XML export and light/dark preview.
- Add `dds-plugin validate` and `pack`, an explicit file allowlist, deterministic
  archives, generated npm metadata and external artifact checksums.
- Add open-source/proprietary publishing guidance, license and disclosure
  templates, versioned notice/receipt APIs and a separate-choice example.

Node hosts execute operator-trusted code in the same process. This release does
not provide OS isolation, automatic package scanning, automatic updates or a
central Marketplace submission service. DDS product compatibility depends on
the installed host version; see the workspace guide.

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
