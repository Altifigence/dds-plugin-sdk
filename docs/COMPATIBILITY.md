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
| Download verification | Node API/CLI since 0.3.1; 0.4.0 accepts exact 0.3.x and 0.4.x package metadata; no extraction, code execution or publisher authentication |
| Development tools | `init`, `doctor`, `dev` since 0.4.0; local Node tools, explicit trusted-code execution |
| Command jobs | Opt-in SDK host/client extension since 0.4.0; progress/logs/UTF-8 artifacts; v1 hello unchanged |

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
