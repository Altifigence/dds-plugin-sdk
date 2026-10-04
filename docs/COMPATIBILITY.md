# Compatibility and availability

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
| Download verification | Node API/CLI since 0.3.1; 0.9.0 accepts exact 0.3.x, 0.4.x, 0.5.x, 0.6.x, 0.7.x, 0.8.x and 0.9.x package metadata; no extraction, code execution or publisher authentication |
| Development tools | `init`, `doctor`, `dev` since 0.4.0; local Node tools, explicit trusted-code execution |
| Command jobs | Opt-in SDK host/client extension since 0.4.0; progress/logs/UTF-8 artifacts; v1 hello unchanged |
| File and job observation | Client helpers since 0.5.0; 0.6 uses revision reads when supported; job reads need enabled 0.4+ hosts |
| Binary job results | Optional 0.7.0 extension; explicit host opt-in; 1 GiB files and 64 KiB chunks; Node resume/full-file verification |
| Durable jobs, history and results | Optional 0.8.0 host stores; current authorization after restart; explicit retry and verified snapshot downloads |
| File revision / conditional read | Optional methods since 0.6.0; bounded full-read fallback on old hosts; v1 hello unchanged |

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
