# DDS Plugin SDK

[Developer guide](https://docs.altifigence.com/developers/plugin-sdk/) ·
[한국어 가이드](https://docs.altifigence.com/ko-kr/developers/plugin-sdk/) ·
[Releases](https://github.com/Altifigence/dds-plugin-sdk/releases) ·
[CI](https://github.com/Altifigence/dds-plugin-sdk/actions/workflows/ci.yml)

Build themes, language features and workspace commands for Digital Design Studio with
a small ESM package, TypeScript declarations and versioned contracts. Connect
your own workspace and tools with the Node.js host and HTTP client. The SDK has
**zero runtime dependencies**.

Version 0.13 adds six [project templates and guarded contract generation](docs/DEVTOOLS.md),
[deterministic synthetic test hosts](docs/testing.md) and opt-in
[local diagnostics and loopback debugging](docs/DIAGNOSTICS.md). Run
`npm run example:devtools` to exercise virtual time, fault injection, pure trace
replay and resource cleanup. Generated projects include separate runtime, test,
TypeScript and distribution checks.

Version 0.12 adds [versioned settings](docs/SETTINGS.md), [execution-scoped secret
references](docs/SECRETS.md), [structured command schemas](docs/DATA_SCHEMAS.md)
and [localization/accessibility helpers](docs/LOCALIZATION.md). Run
`npm run example:configuration` for the independent HTTP example or
`npm run example:configuration-browser` for EN/KO, RTL and long-label forms.

Version 0.11 adds [signature help and completion assistance](docs/LANGUAGE_ASSISTANCE.md),
including lazy item resolution, limited snippets and pure insertion previews.
Run `npm run example:assistance` for the nested-call and Unicode example.
[Reviewed workspace edits](docs/WORKSPACE_EDITS.md) add rename proposals, multi-file
previews, conditional application and readback after interrupted operations.
[Formatting and code actions](docs/LANGUAGE_EDITING.md) use that review path for
document/range formatting and diagnostic-bound, optionally lazy quick fixes.
[Language display](docs/LANGUAGE_DISPLAY.md) adds bounded semantic full/delta
tokens, folding, literal inlay hints and hierarchical symbols with a browser example.

The 0.10 line adds [browser artifact streaming](docs/BROWSER_ARTIFACTS.md)
with bounded sinks, incremental whole-file hashes, explicit storage readback and
main-thread/Worker examples, and [selected-file uploads](docs/UPLOADS.md) with private
staging, explicit restart recovery and verified conditional commit. A caller-owned
[transfer queue](docs/TRANSFER_QUEUE.md) schedules mixed uploads/downloads with
chunk fairness, pause/resume, rate budgets and bounded safe retries.
[Worker OPFS checkpoints](docs/BROWSER_RESUME.md) allow explicit recovery after
reload or host restart, with prefix hashes and cross-tab exclusive ownership.

This is the intentionally public SDK for external plugin developers. The DDS
application, private engines/services and production signing systems are outside
this repository. Read the [public scope](docs/PUBLIC_SCOPE.md) and
[compatibility table](docs/COMPATIBILITY.md) for exact boundaries.

Version **0.13.0** supports Node 22 and 24. Manifest v1 diagnostic plugins remain
compatible. Manifest v2 adds commands, permission-scoped workspace and backend
APIs, and open-source or proprietary distribution metadata. Themes export to
the XML format already supported by DDS. The workspace host runs trusted plugins
in the operator's process; it is not an OS sandbox or a central Marketplace.

Start a standalone plugin with [`dds-plugin init`](docs/DEVTOOLS.md), diagnose it
without executing code with `doctor`, and run trusted code with `dev --watch`.
[Command jobs](docs/JOBS.md) add progress, logs, cancellation and pinned result
files to explicitly enabled hosts while keeping existing API contracts.

Optional [durable job storage](docs/JOB_STORAGE.md), [history and explicit retry](docs/JOB_HISTORY.md)
and [stored result files](docs/ARTIFACT_STORAGE.md) retain verified results across
process restarts. Enable retention deliberately on the operator-owned host.
[Workspace observation](docs/OBSERVATION.md) follows explicit file revisions and
job progress with cancellable async iterators, preserving edit drafts and job IDs.
[File revisions and conditional reads](docs/FILE_REVISIONS.md) reduce response
traffic on new hosts, with bounded full-read fallback on older hosts.
[Binary job results](docs/BINARY_ARTIFACTS.md) add optional 64 KiB chunk reads and
a Node downloader with interruption, resumption and whole-file SHA-256 verification.

Optional [project observation](docs/PROJECT_WATCH.md) uses explicit roots,
content-verified reconciliation and bounded resync events. [Project tree and
search](docs/PROJECT_QUERIES.md) add scoped queries, content revisions and pages
that identify external changes. The [HTTP/project client](docs/PROJECT_TOOLS.md)
connects these tools while preserving edit drafts, with bounded subscription leases
and explicit reconnect behavior. Run `npm run example:project-tools`, or
`npm run example:project-browser` for the local browser scenario.

## Run your first plugin

```sh
git clone https://github.com/Altifigence/dds-plugin-sdk.git
cd dds-plugin-sdk
npm ci
npm test
npm run example
```

The [Hello Diagnostics plugin](examples/hello-diagnostics/plugin.mjs) finds a
`TODO` in a supplied text document. It uses no external tool or service.

```text
Hello Diagnostics: 1 diagnostic
info 2:1 Resolve this TODO before sharing the document.
```

Edit the provider in `examples/hello-diagnostics/plugin.mjs`, then rerun the
example. [The runner](examples/hello-diagnostics/run.mjs) shows how to activate
your plugin, supply a snapshot, request diagnostics and dispose the host.

## Use the released package in your project

Create an ESM project and install the exact release archive:

```sh
mkdir my-dds-plugin
cd my-dds-plugin
npm init -y
npm pkg set type=module
npm install --ignore-scripts --save-exact https://github.com/Altifigence/dds-plugin-sdk/releases/download/v0.13.0/altifigence-dds-plugin-sdk-0.13.0.tgz
```

Copy the example's `plugin.mjs` and `run.mjs` into this directory, then run:

```sh
node run.mjs
```

The package uses native JavaScript modules; no build step is required. TypeScript
users can import the same package with `module` and `moduleResolution` set to
`NodeNext`. The tarball is distributed through [GitHub Releases](https://github.com/Altifigence/dds-plugin-sdk/releases),
and the install command includes the release URL rather than an npm registry lookup.

## API and tests

| Import | Use |
| --- | --- |
| `@altifigence/dds-plugin-sdk` | Plugin host, diagnostics, language providers and completion assistance, bounded parsers, types and lifecycle helpers |
| `@altifigence/dds-plugin-sdk/testing` | `createTestHost` for trusted local plugins |
| `@altifigence/dds-plugin-sdk/schemas` | JSON Schema objects, loaded separately from the core API |
| `@altifigence/dds-plugin-sdk/themes` | Validate a theme and export DDS XML without executing theme code |
| `@altifigence/dds-plugin-sdk/workspace-node` | Serve an explicit project directory and operator-selected plugins/tools |
| `@altifigence/dds-plugin-sdk/workspace-client` | Authenticated client, project edit sessions, file observation and job completion helpers |
| `@altifigence/dds-plugin-sdk/publishing` | Node.js allowlist validation, deterministic packaging and downloaded archive verification |
| `@altifigence/dds-plugin-sdk/consent` | Versioned notices, explicit local receipts and permission identity checks |
| `@altifigence/dds-plugin-sdk/devtools` | Create projects, diagnose metadata and run/watch trusted local plugin code |
| `@altifigence/dds-plugin-sdk/artifacts` | Binary result metadata, ranges, base64 decoding and transfer contracts |
| `@altifigence/dds-plugin-sdk/job-storage` / `job-storage-node` | Durable job contracts and the single-writer Node store |
| `@altifigence/dds-plugin-sdk/job-history` | Bounded history queries, pagination and retry relationships |
| `@altifigence/dds-plugin-sdk/artifact-storage` / `artifact-storage-node` | Retained result contracts, verified bytes and explicit retention |
| `@altifigence/dds-plugin-sdk/jobs` | Job contracts, lifecycle states, bounded event pages and file references |

[API reference](docs/api.md) explains the manifest, permissions, requests,
ranges, cancellation and error codes. [Write a plugin test](docs/testing.md)
with Node's built-in test runner. [Performance](docs/performance.md) describes
the repeatable synthetic benchmark.

```sh
npm run check       # schemas, runtime tests, types, example and packed consumer
npm run pack:check  # install the tarball in a separate temporary project
npm run benchmark  # bounded local measurements
```

The developer test host executes trusted modules in the same process. Production
hosts must provide their own code isolation and permission enforcement. The
[host contract](docs/host-contract.md) gives the adapter requirements.

## Add language features

Run `npm run example:language` for completion, hover, definition, references and
document symbols. The [language guide](docs/LANGUAGE.md) covers typed providers,
explicit grants, plain-text results and stale-document cancellation. These are
SDK host APIs; product editor support requires a separate DDS integration.

## Make a theme

Edit [Hello Ocean](examples/hello-theme/theme.json), then run:

```sh
npm run example:theme
```

The example writes `hello-theme.xml` and a light/dark browser preview. In DDS,
open **Plugins → Install theme**, select the XML and choose **Apply**. See the
[theme guide](docs/THEMES.md) for the exact palette, metrics and import paths.
Themes contain visual tokens and request no file or backend access.

## Keep the project and plugins in your environment

The [workspace guide](docs/WORKSPACES.md) runs a project on your own WSL,
container or server. The workspace protocol supports listing, reading and
editing project files with revision checks, and invoking registered plugin
commands in that same environment. A command can call an operator-defined
backend function or a fixed executable with JSON input/output.

Hosts require an explicit token and workspace identity. Use HTTPS for a remote
server or loopback HTTP for local development. Operators choose the root,
plugins and tools; clients cannot submit arbitrary module paths or shell
commands. Each client must review and grant access before using a connection.
See the [protocol](docs/workspace-protocol.md) for limits and cancellation.

Use [project edit sessions](docs/PROJECTS.md) to retain a file revision, apply
bounded text edits and recover from conflicts through explicit reload. Run
`npm run example:project` for a complete temporary HTTP workspace example.

## Publish an open-source or proprietary plugin

Copy [the publishable example](examples/publishable-plugin), set your own
identity, license and disclosure, and list the files to distribute:

```sh
npx --no-install dds-plugin validate ./my-plugin
npx --no-install dds-plugin pack ./my-plugin --out ./dist
```

The CLI produces a tarball and separate release metadata with its SHA-256.
It does not execute the plugin, upload it, accept terms or grant access.
Publish through your own GitHub Release, private registry or download channel.

[Publishing](docs/PUBLISHING.md) covers package metadata and release steps.
[Licensing](docs/LICENSING.md) explains the SDK's Apache-2.0 license, independently
licensed plugins and third-party obligations. [Consent](docs/CONSENT.md)
separates permission grants, plugin terms, notices and optional personal-data
consent. The SDK does not require a proprietary click-through agreement.

## Verify a downloaded plugin

Before using someone else's plugin archive, run
[`dds-plugin verify`](docs/VERIFYING.md) with its release metadata and an
independently obtained expected SHA-256. It checks bounded file contents and
package structure without running or extracting code. This is not publisher
authentication or malware scanning. Try `npm run example:verify` for a complete
temporary package/verification example.

## Contribute


See [CONTRIBUTING](CONTRIBUTING.md), [SECURITY](SECURITY.md) and
[CHANGELOG](CHANGELOG.md). The SDK and included examples are licensed under
[Apache-2.0](LICENSE).
