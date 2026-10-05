# Compatibility and availability

## 1.0 stable API

`1.0.0` retains the RC runtime/protocol API. Newly packed plugins use
`>=1.0.0 <2.0.0`; raise the minimum before using an API added in a later minor.
The verifier preserves exact historical 0.3.x–0.13.x and `1.0.0-rc.1` metadata.
Revalidate and repack an RC plugin as a new plugin version for stable installation.
Archive verification does not widen installation ranges. See [release contents](RELEASE_1_0.md)
for accepted profiles and the separately deferred security audit.

## 1.0 release candidate

`1.0.0-rc.1` retains the 0.13 public runtime and protocol contracts and adds
[host conformance](CONFORMANCE.md), a complete [API inventory](../API_SUPPORT.json)
and an explicit [support/migration policy](SUPPORT_POLICY.md). New RC plugin archives
pin the exact `1.0.0-rc.1` peer. Verification still accepts exact 0.3.x–0.13.x
metadata without widening any archive's original range. Revalidate and repack to
change a plugin's installation range. Actual old-archive wire interoperability
tests do not make those SDK lines maintained or prove every optional feature exists.

Stable 1.x policy is a GA commitment; RC acceptance and known limits are recorded
in [the acceptance report](RC_ACCEPTANCE.md). DDS product releases remain separate.

## 0.13 development and diagnostics

Six feature templates, guarded contract generation, synthetic scenario ports,
optional owner-supplied runtimes and local diagnostics add no workspace protocol
method or implicit grant. Existing `createTestHost()` diagnostics defaults remain.
New `host.inspect()` reports unsettled SDK-owned operations after disposal;
diagnostic providers and pending activations now retain their slots until actual
settlement. Operator `replaceGrants()` deactivates plugins losing permissions.
Ports are trusted host controls, not APIs granted to a plugin.
Settings-store `inspect()` now also remains available after disposal for cleanup
checks; its data read and mutation methods still reject a disposed store.

New plugin archives use `>=0.13.0 <0.14.0`. Archive verification retains exact
released 0.3.x through 0.12.x metadata, without widening an old plugin's declared
range. Independent source/contract compatibility checks are separate from that
package-manager range. See [development tools](DEVTOOLS.md), [testing](testing.md)
and [local diagnostics](DIAGNOSTICS.md) for the v1 report and trace contracts.

## 0.12 configuration and display

[Settings](SETTINGS.md) and [secret references](SECRETS.md) are operator-owned
optional ports. New `settings` capability, `settings.read`/`secrets.resolve`
permissions, manifest display and [command schema metadata](DATA_SCHEMAS.md)
require a 0.12-aware peer. Existing diagnostics, language features, commands and
workspace protocol v1 continue to work. Older clients reject unknown metadata;
an unchanged protocol version does not make new fields readable by an old peer.
Keep legacy definitions when using old clients. Cancellation now retains normal
command/port slots until actual provider settlement, as jobs already did.

[Locale catalogs and accessibility helpers](LOCALIZATION.md) return display data
and bounded inspection hints. They do not change DDS product UI or theme XML.
New plugin archives use `>=0.12.0 <0.13.0`; verification preserves exact released
0.3.x through 0.11.x peer metadata. An old archive's peer range is not widened.

## 0.11 language assistance and editing

Optional `signature-help`, `completion-resolve` and `completion-snippets` extend the
in-process host. Existing five language features and literal completion remain
available. Older SDKs reject unknown manifest capabilities; these extensions do not
change the workspace HTTP protocol. New plugin archives declare `>=0.11.0 <0.12.0`;
verification retains the exact previously published 0.3.x through 0.10.x metadata.
See [language assistance](LANGUAGE_ASSISTANCE.md) for bounds and runtime checks.
`prepare-rename`/`rename` add proposals; [workspace edits](WORKSPACE_EDITS.md) preview
and apply them through existing file methods with a separate current approval and
journal. The Node journal is optional, operator-owned storage outside the workspace.
[Formatting and code actions](LANGUAGE_EDITING.md) are opt-in language proposals;
accepted diagnostic publications invalidate action selections. Existing diagnostic
call results and single-file edit sessions retain their contracts.
[Semantic tokens, folding, hints and hierarchical symbols](LANGUAGE_DISPLAY.md)
extend SDK hosts and include a standalone browser example. The flat symbol API
is unchanged. These features do not establish a DDS product editor integration.

| Surface | Supported scope |
| --- | --- |
| SDK runtime | Node.js 22 or 24; ESM with TypeScript declarations; no runtime dependencies |
| Manifest v1 | Existing diagnostics plugins remain supported |
| Manifest v2 | Commands, language features, workspace/backend permissions and distribution metadata |
| Workspace protocol v1 | Explicit user-operated server, authenticated client, revision checks and approved commands |
| Themes | DDS XML v2 import; themes do not execute plugin code |
| DDS native workspace UI | Requires a DDS release containing **Connect user workspace…**; SDK installation alone does not add this product feature |
| Browser-only DDS host | Native workspace transport is unavailable |
| Language providers | Diagnostics plus completion, hover, definition, references and document symbols in SDK hosts since 0.3.0; no released DDS editor bridge is implied |
| Project edit sessions | Client helpers in 0.3.0 over unchanged workspace protocol v1, including 0.2.x servers |
| Download verification | Node API/CLI since 0.3.1; 1.0.0 accepts exact 0.3.x–0.13.x, RC1 and current stable package metadata; no extraction, code execution or publisher authentication |
| Development tools | `init`, `doctor`, `dev` since 0.4.0; six templates, `generate`, synthetic testing and local profiles in 0.13 |
| Command jobs | Opt-in SDK host/client extension since 0.4.0; progress/logs/UTF-8 artifacts; v1 hello unchanged |
| File and job observation | Client helpers since 0.5.0; 0.6 uses revision reads when supported; job reads need enabled 0.4+ hosts |
| Binary job results | Optional 0.7.0 extension; explicit host opt-in; 1 GiB files and 64 KiB chunks; Node resume/full-file verification |
| Durable jobs, history and results | Optional 0.8.0 host stores; current authorization after restart; explicit retry and verified snapshot downloads |
| File revision / conditional read | Optional methods since 0.6.0; bounded full-read fallback on old hosts; v1 hello unchanged |
| Browser streaming and selected-file uploads | Since 0.10.0; explicit file/OPFS sinks and optional server upload store; independent current authority and full hashes |
| Browser checkpoint recovery | Since 0.10.0; dedicated Worker + OPFS sync access + Web Locks, currently approved stored references and explicit partial selection; Chromium 154 on Windows exercised |

This is a developer preview. Pin the exact package release and read the changelog
before updating. SDK, protocol, plugin and DDS product versions are distinct.
Hosts must reject unsupported contracts and enforce permissions, isolation and
lifecycle rules. A source integration or passing SDK test does not prove an
installed DDS product has a feature.

Hosts older than 0.3.0 reject the new language capabilities and `language.provide`
permission. Existing API contracts remain supported in 0.3.0. Plugin archives
created by the 0.2.x CLI have a peer range ending before 0.3.0: their publisher
must validate and repack a new plugin version for this SDK. The 0.3.0 CLI pins
new plugin archives to `>=0.3.0 <0.4.0`; it does not infer compatibility from source.

0.3.1 keeps that same peer range and runtime contracts. Existing 0.3.0 plugin
archives do not need repacking for this update. The new download-verification
command requires SDK 0.3.1 and verifies plugin packages, not SDK tarballs.

0.3.2 is the security update for this line. Upgrade both workspace servers and
clients: only an upgraded server supplies the stricter file policy and incoming
request limits. Hardlinks, additional credential stores and Windows device
aliases are now rejected. Ordinary files, APIs and protocol 1 remain compatible.
An archive containing newly excluded files needs those files removed and a new
plugin version. See [Security](../SECURITY.md) for migration and remaining limits.

Use the [official guide](https://docs.altifigence.com/developers/plugin-sdk/),
[host contract](host-contract.md) and [workspace guide](WORKSPACES.md) together.

0.4.0 retains the 0.3.2 security boundaries, manifest versions, short-command APIs,
language APIs and project edit sessions. Existing 0.3 clients can connect to 0.4
servers and use their existing methods. Job methods are new: call
`getJobCapabilities()` first and handle older-server rejection without fallback
execution. Both sides must support 0.4 for jobs; hosts must explicitly enable it.

The 0.4 packer generates `>=0.4.0 <0.5.0` peers, preventing job-dependent plugins
from being installed automatically on 0.3. The archive verifier accepts the exact
previous `>=0.3.0 <0.4.0` metadata, but that does not make an old archive installable
on 0.4: its publisher must validate against 0.4 and repack a new plugin version.
Neither tool infers compatibility from code. DDS application/Windows releases
remain separately versioned and are not changed by this SDK release.

0.5.0 adds pull-driven observation without changing hello, workspace protocol,
manifest or job contracts. File observers keep edit snapshots intact; job
observers keep command execution separate from waiting and reconnecting.
Existing 0.4 job clients and 0.3.2 file clients keep their original methods on a
0.5 host. New clients fail directly when an old host lacks jobs; they never
fall back to submitting a command. See [observation](OBSERVATION.md).

New 0.5 plugin archives declare `>=0.5.0 <0.6.0`. Archive verification preserves
the exact original 0.3/0.4 peer metadata; it does not make those archives
installable on 0.5. Publishers must validate and repack a new plugin version.

0.6.0 adds optional file discovery, revision-only reads and conditional reads.
Known pre-0.6 SDK hosts use the original file read without probing. Other hosts
may explicitly return unsupported discovery; malformed replies and access or
transport failures never trigger fallback. See [file revisions](FILE_REVISIONS.md).

New 0.6 archives declare `>=0.6.0 <0.7.0`. Verification also preserves exact
0.3/0.4/0.5 metadata, without widening peers; publishers must validate and repack
for 0.6. SDK and DDS product releases remain separate.

0.7.0 adds binary job results through separate optional methods. Existing v1
hello, text file, snapshot and event contracts remain valid for older clients;
binary registrations are listed separately. New clients report binary support
as disabled on known pre-0.7 SDK hosts, without falling back to text transfer.
See [binary artifacts](BINARY_ARTIFACTS.md).

New 0.7 archives declare `>=0.7.0 <0.8.0`. Verification retains exact older
0.3/0.4/0.5/0.6 peer metadata. Validate and repack a new plugin version for 0.7.

0.8.0 adds optional job history, durable metadata and retained result files through
separate `history.*` and `snapshots.*` methods. Memory-only defaults and v1
responses remain compatible. New clients report storage disabled on known 0.7
and earlier hosts without probing; old clients keep the original live/source
methods. No durable format existed in earlier tagged SDKs. A restart requires
a fresh connection and current grants; old generations and cursors cannot be reused.

New 0.8 archives declare `>=0.8.0 <0.9.0`. Verification preserves exact
0.3/0.4/0.5/0.6/0.7 metadata. Validate and repack a new plugin version for 0.8;
verification alone does not widen installation ranges. See [storage](JOB_STORAGE.md),
[history](JOB_HISTORY.md) and [retained results](ARTIFACT_STORAGE.md).

0.9.0 adds optional scoped project observation, tree/search and separate
`projects.*` HTTP methods. Existing v1 hello, files, jobs, storage and snapshot
methods retain their shapes. Known pre-0.9 SDK hosts receive no project discovery
probe and report unsupported; no broader directory or command fallback occurs.
Reconnect requires new project/watch sessions and a fresh query when relevant.
See [project tools](PROJECT_TOOLS.md) for leases, resync and preserved drafts.

New 0.9 plugin archives declare `>=0.9.0 <0.10.0`. Verification also preserves
exact 0.8 and earlier metadata; installation still requires publisher validation
and a newly packed plugin version for the selected SDK line.

0.10.0 adds opt-in `uploads.*` methods and browser-safe bounded streaming,
mixed transfer scheduling and explicit Worker OPFS recovery. Existing file,
project, command, job and stored-artifact v1 contracts retain their wire shapes.
Known 0.3–0.9 hosts report uploads disabled without a new-method probe. Browser
live-result streaming needs a 0.7+ binary host; stored recovery needs a 0.8+
snapshot host with current grants. Feature presence alone is not browser
qualification. See [streaming](BROWSER_ARTIFACTS.md), [uploads](UPLOADS.md),
[queue](TRANSFER_QUEUE.md) and [checkpoints](BROWSER_RESUME.md).

New 0.10 plugin archives declare `>=0.10.0 <0.11.0`. Exact previous metadata is
accepted for verification without changing peer ranges. Validate and repack a new
plugin version for this SDK; none of these APIs deploys or changes a DDS product.
