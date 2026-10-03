# Changelog

## 0.3.1 — 2026-10-03

- Verify downloaded 0.3.x plugin archives and release metadata with the new
  `verifyPluginArchive()` API and `dds-plugin verify` CLI without extracting or
  executing code. Optionally pin an independently obtained SHA-256.
- Bound compressed/decompressed input and recheck tar structure, explicit file
  inventory, manifest/disclosure/license and inert generated npm metadata.
- Reject file/directory path conflicts during both packing and verification.
- Add adversarial tests, a complete independent consumer example and EN/KO
  verification guidance. Hash checks do not authenticate publishers or scan malware.

Runtime/manifest/workspace contracts and `>=0.3.0 <0.4.0` plugin peers are
unchanged. Existing 0.3.0 plugin archives remain usable without repacking.

## 0.3.0 — 2026-10-03

- Add typed completion, hover, definition, references and document-symbol
  providers with explicit `language.provide` permission and bounded plain data.
- Reuse diagnostics lifecycle handling for cancellation, deadlines, selection,
  immutable identities and stale/late-result rejection across language features.
- Add connection-bound workspace projects, CAS edit sessions, explicit reload
  after conflict or uncertain writes, and bounded UTF-16 text edits.
- Include runnable language and HTTP project examples, schemas and EN/KO guides.
- Pack new plugins with SDK peer requirement `>=0.3.0 <0.4.0`. Publishers must
  validate/repack older archives whose peer range excluded 0.3.0.

Existing manifest v1/v2 APIs and workspace protocol v1 remain supported. New
language declarations require a 0.3.0 host and new explicit permission grants.
This SDK release does not ship a DDS editor bridge or product update.

## 0.2.1 — 2026-10-03

- Reject recognizable key/token material inside allowed plugin files and additional
  SSH/cloud credential paths without echoing detected values.
- Verify the SDK's exact public package inventory and source boundary in CI, with
  negative tests for extra package files, private imports and credentials.
- Document the independent SDK's public scope, host availability and official guides.

The new checks are conservative safeguards, not complete secret or malware scans.
Existing manifests, workspace protocol and plugin APIs remain compatible.

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
