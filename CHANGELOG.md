# Changelog

## 0.10.0 — in development (not yet released)

- Browser artifact streaming with caller-owned file/OPFS sinks and distinct
  received versus stored verification.
- Opt-in selected-file uploads with bounded private staging, current plugin/write
  authority, chunk/full hashes, explicit restart recovery and conditional commit.
- Caller-owned mixed transfer queue with chunk scheduling, connection/resource/rate
  limits, pause/resume, bounded transient chunk retries and distinct verified progress.
- Keep project, text-file, job and artifact v1 contracts and released 0.3–0.9
  plugin package metadata verification. See [uploads](docs/UPLOADS.md).

## 0.9.0 — 2026-10-04

- Add operator-scoped Node project observation with bounded native hints, content
  reconciliation, initial snapshots, cursors and explicit full-view resync events.
- Add paged tree, filename/glob and literal text queries. Captured content hashes,
  UTF-16 ranges and snippets remain stable while later pages identify changed,
  missing or unverified files. Byte, time, result and cursor limits stay explicit.
- Add optional authenticated `projects.*` HTTP methods, subscription leases,
  snapshot verification and client/project helpers. Reconnect starts a new view;
  observation never overwrites edit snapshots or caller drafts. Known older hosts
  report projects unavailable without unknown probes or broader file queries.
- Include typed contracts, ten project schemas, installed consumer examples and a
  local browser scenario covering creation, search, external edit, CAS conflict,
  same-scope query refresh, resource cleanup and reconnect.
- Verify existing process-backend cleanup before removing a cancelled job's
  temporary working directory on Windows.
- New plugin archives declare `>=0.9.0 <0.10.0`; the verifier preserves exact
  0.3/0.4/0.5/0.6/0.7/0.8 package metadata without widening their peer ranges.

## 0.8.0 — 2026-10-04

- Add bounded history queries with snapshot cursors, current-grant filtering and
  explicit retry relationships. Repeated attempts are idempotent across restart.
- Add storage discovery, recovery/history/retry HTTP methods and client helpers;
  known older hosts retain their original behavior without unknown probes.

- Add opt-in durable job storage, bounded coalesced checkpoints, current-authority
  recovery receipts and a single-writer Node filesystem implementation.
- Preserve v1 responses and memory-only defaults. Recovery distinguishes settled,
  interrupted, expired, corrupt and unsupported records without rerunning commands.
- Default to metadata-only retention with explicit reviewed redaction, quotas,
  pruning, stale-owner checks and an opt-in legacy import preserving original bytes.
- Add optional verified text/binary result snapshots sharing the job store lock,
  bounded retention and explicit operator inspection/removal/pruning. Current
  authority and fresh references allow downloads to resume after process restart
  and source deletion; existing source-reference APIs keep their semantics.
- Include typed APIs, eleven storage/history schemas and packed real-process
  examples for crash recovery, explicit retry and snapshot downloads.
- New plugin archives declare `>=0.8.0 <0.9.0`; verification preserves exact
  0.3/0.4/0.5/0.6/0.7 metadata without widening peer ranges.

## 0.7.0 — 2026-10-04

- Add optional binary job result registration and discovery, with SHA-256-pinned
  metadata, 1 GiB files and bounded 64 KiB reads. Existing v1 text/job shapes remain
  compatible; enabling jobs alone does not enable binary artifacts.
- Add a Node downloader with explicit partial-file resumption, streaming whole-file
  and staging-file verification, cancellation and no-overwrite publication.
- Preserve scope, permission, protected-path, link, mutation and resource boundaries.
  Known older hosts report the extension disabled; no text/command fallback occurs.
- Publish matching types, five schemas, a real HTTP example and transfer benchmark.
  New archives declare `>=0.7.0 <0.8.0`; old 0.3/0.4/0.5/0.6 metadata remains verifiable.

## 0.6.0 — 2026-10-04

- Add optional file capability discovery, revision-only reads and conditional
  reads. Unchanged conditional replies omit content. Existing v1 hello, file
  read/write, manifest and job contracts remain unchanged.
- Use revision reads for file observers on supporting hosts, with bounded full
  reads on known pre-0.6 SDK hosts or explicitly unsupported discovery. Errors
  and malformed replies never cause silent downgrade. Connection changes clear
  discovery; cancellation and protected-file bounds remain enforced.
- Add TypeScript declarations, three JSON schemas and a repeatable HTTP body
  bandwidth benchmark. Server reads and hashes still run for every sample.
- New plugin archives declare `>=0.6.0 <0.7.0`; verification accepts exact
  0.3/0.4/0.5 metadata without widening peer ranges. Validate and repack for 0.6.

## 0.5.0 — 2026-10-03

- Add `project.watchFiles()` for 1–16 explicit file paths, with initial,
  created, changed and deleted revision events. Sampling never replaces an
  edit session's retained snapshot or saves a draft.
- Add `client.watchJob()` and `waitForJob()` over existing job requests, with
  bounded event pages, dropped-event reporting and explicit cursor resumption.
  Waiting never submits or cancels a command.
- Bind observers to their client connection with one pending read, eight
  shared slots, deadlines, AbortSignal support and deterministic disposal.
  Preserve authentication/revocation errors and ignore late replies.
- Keep workspace protocol v1 and 0.3.2 file / 0.4 job host compatibility.
  New archives declare `>=0.5.0 <0.6.0`; verification accepts exact 0.3 and 0.4
  metadata without broadening old peers. Validate and repack for 0.5 installs.
- Include TypeScript declarations, an installed-package observation example
  and lifecycle, event-order, draft-conflict and compatibility tests.

This is a developer preview. SDK helpers do not add DDS product UI, durable jobs,
recursive filesystem watchers or new permission grants.

## 0.4.0

- Add `dds-plugin init`, `doctor` and `dev` plus Node APIs. Scaffolds pin the SDK
  release; diagnostics never execute plugin code; explicitly trusted dev runs in
  a supervised child with bounded output and allowlist-based watch/restart.
- Add opt-in command jobs with progress, bounded log pages, stable job IDs,
  cancellation, deadlines and revision-pinned UTF-8 result files. Existing
  workspace/backend permissions, auth and host generation checks still apply.
- Add five job schemas, TypeScript declarations and an executable HTTP example.
  Preserve v1 hello and existing methods for 0.3 clients. New plugin packages
  declare `>=0.4.0 <0.5.0`; verification still accepts exact 0.3 metadata without
  changing its peer range. Publishers must validate and repack for 0.4 installs.
- Verify dev process/descendant cleanup, watch restart, job lifetime/quota/grant
  boundaries, actual process cancellation and independently installed consumers.

Jobs are in-memory, default disabled, limited to trusted SDK hosts, and do not add
installed DDS UI or a sandbox. See [development tools](docs/DEVTOOLS.md),
[jobs](docs/JOBS.md) and [compatibility](docs/COMPATIBILITY.md).

## 0.3.2 — 2026-10-03

- Harden the user workspace file API against hardlink aliases of excluded files
  or files outside the selected root. Reads, writes, rename and removal reject
  multiply linked files; listings omit them. Normal single-link files and CAS
  behavior remain supported.
- Share credential filename exclusions across workspace access, plugin
  packaging/verification and the public-source guard. Add netrc/Git credential
  stores, GnuPG/Kubernetes/Docker directories and additional SSH key names where
  missing. Reject Windows superscript device aliases, console device names and
  malformed Unicode workspace paths before I/O.
- Admit at most 16 incoming HTTP request bodies before buffering; return HTTP
  429 at capacity. Bound connections to 128 and requests per socket to 128.
  Keep execution/cancellation limits separate and release upload slots on every
  completion, rejection, disconnect and timeout. Check the raw header count.
- Cancel unread rejected responses and stalled response streams on client
  cancellation/deadline, including custom transports that ignore their signal.
- Update the supported security-fix line and migration guidance. The 0.3.x
  plugin peer range, manifest contracts and workspace protocol remain unchanged.
  Previously accepted hardlinks and newly excluded paths are intentionally
  rejected. This does not add publisher authentication, malware scanning or an
  OS sandbox for trusted in-process plugins.

## 0.3.1 — 2026-10-03

- Verify downloaded 0.3.x plugin archives and release metadata with the new
  `verifyPluginArchive()` API and `dds-plugin verify` CLI without extracting or
  executing code. Optionally pin an independently obtained SHA-256.
- Bound compressed/decompressed input and recheck tar structure, explicit file
  inventory, manifest/disclosure/license and inert generated npm metadata.
- Reject file/directory path conflicts during both packing and verification.
- Add adversarial tests, a complete independent consumer example and EN/KO
  verification guidance. Hash checks do not authenticate publishers or scan malware.
- Correct the theme metadata's current DDS popover-radius default to 16. The
  serializer still preserves omitted metrics and explicit example overrides.

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
