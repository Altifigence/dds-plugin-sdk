# API reference — 0.3.0

Import portable values and types from `@altifigence/dds-plugin-sdk`. The core
validates plain data, manages plugin lifetimes and dispatches diagnostics, language features,
commands and explicit host ports. It performs no Node filesystem, process or
network operations. See [WORKSPACES](WORKSPACES.md) for the separate Node server
and client, [THEMES](THEMES.md) for XML themes, and [PUBLISHING](PUBLISHING.md)
and [CONSENT](CONSENT.md) for package review and acceptance.

## Manifests and activation

`definePlugin(manifest, activate)` returns a frozen `{manifest, activate}` after
validating an independent copy. The host calls `activate(context)`; return
`undefined` or a `Disposable` with `dispose()`, synchronously or asynchronously.
The host owns registration cleanup even if a plugin's disposer throws.

The diagnostics protocol remains **1**. Manifest versions **1** and **2** are
separate accepted shapes; the [manifest schema](../schemas/manifest.schema.json)
contains both alternatives. Existing v1 plugins retain the original fields,
single identifier `license`, diagnostics capability, two diagnostics
permissions and `supportedHosts: ['test-host']`.

Version 2 adds `runtime`, `source`, commands and workspace permissions:

```js
import { definePlugin } from '@altifigence/dds-plugin-sdk';

export default definePlugin({
  manifestVersion: 2,
  id: 'example-workspace', name: 'Example Workspace', publisher: 'example',
  version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs',
  runtime: 'workspace', capabilities: ['commands'],
  permissions: ['workspace.read', 'workspace.write', 'backend.invoke'],
  supportedHosts: ['test-host', 'workspace-host'],
  license: 'Apache-2.0',
  source: {visibility: 'open', licenseFile: './LICENSE',
    repository: 'https://github.com/example/example-workspace'},
}, context => context.registerCommand({
  id: 'summarize', title: 'Summarize a saved file',
  parameters: [{name: 'path', label: 'File path', type: 'string', required: true}],
}, async (input, {signal}) => {
  const file = await context.workspace.readFile(input.path, {signal});
  return context.backends.invoke('summarize', {content: file.content}, {signal});
}));
```

Every field shown in this manifest is required except `source.repository`.
IDs and publishers use lowercase letters/digits with `.`, `_`, `-` separators,
starting with a letter; `version` follows SemVer. `entry` is a relative `.mjs`
path without traversal. `createPluginHost()` receives an explicitly imported
module and does not load that path.

V2 `runtime` is `ui` or `workspace`. UI manifests cannot request
`workspace.read`, `workspace.write` or `backend.invoke`. Runtime is compatibility
metadata, not an isolation mechanism. `source.visibility` is `open` or `closed`;
`source.licenseFile` is a relative file path, canonicalized without leading `./`.
An optional repository must use credential-free HTTPS without a query or hash.
The parser validates metadata, not file existence or public repository access.

V2 `license` accepts bounded SPDX-style expression grammar, including `AND`,
`OR`, `WITH`, parentheses and `LicenseRef-` identifiers. For example,
`MIT OR Apache-2.0` or `LicenseRef-Proprietary`. `parseLicenseExpression()`
checks syntax; it does not verify SPDX registry membership, copyright ownership,
license eligibility or agreement acceptance. See [LICENSING](LICENSING.md).

| Activation context member | Behavior |
| --- | --- |
| `host` | `{id: 'test-host' \| 'workspace-host', version: '0.3.0', protocolVersion: 1}` |
| `pluginId`, `scope` | Manifest ID and opaque host `{projectId, sessionId}` |
| `grants` | Frozen intersection of host grants and manifest permissions |
| `signal` | Aborted on deactivation, host disposal or activation timeout |
| `registerDiagnosticsProvider(selector, provider)` | Require declared diagnostics capability and both effective diagnostics grants |
| `registerLanguageProvider(kind, selector, provider)` | Require declared feature and effective `document.read` / `language.provide` grants |
| `registerCommand(definition, handler)` | Require declared commands capability; return a registration `Disposable` |
| `workspace` | Permission-checked saved-file read, list and CAS write APIs |
| `backends` | Permission-checked invocation of named, host-configured handlers |

`createPluginHost()` defaults to **no grants**. `createTestHost()` from
`@altifigence/dds-plugin-sdk/testing` preserves its v1 compatibility defaults:
`test-host` and both diagnostics grants. Permission declarations do not grant
themselves access. A missing optional port returns `capability_unavailable`.

## Commands and parameters

`context.registerCommand(definition, handler)` takes `{id, title,
description?, parameters?}`. Each parameter is `{name, label, type, required,
choices?}`; types are `string`, `number` or `boolean`. `choices` is a nonempty
unique array available only for string parameters. A command supports at most
32 parameters and each string choice has at most 256 code points.

If `parameters` is omitted, the input may be any bounded `JsonValue`. If present,
including an empty array, input must be an object containing only the named
parameters. Required values must be supplied, types must match and choices must
match exactly. The SDK provides no parameter defaults or coercion.

```js
const registration = context.registerCommand({
  id: 'greet', title: 'Say hello',
  parameters: [{name: 'name', label: 'Your name', type: 'string', required: true}],
}, (input, {signal}) => {
  signal.throwIfAborted();
  return {message: `Hello, ${input.name}!`};
});
```

The host lists immutable metadata with `host.listCommands()` and calls
`host.executeCommand(pluginId, commandId, input, {signal?, timeoutMs?})`.
Handlers return `JsonValue` or a promise of it. Input and output are copied and
bounded; class instances, functions, accessors, symbols, sparse arrays,
non-finite numbers and cycles are rejected. Registration disposal aborts its
pending calls. [Language providers](LANGUAGE.md) add completion, hover, definition,
references and document symbols. Code actions and automatic edit application are
not implemented. Client-side [project edit sessions](PROJECTS.md) save explicitly
provided content or text edits with revision checks.

## Workspace and backend ports

| Plugin method | Permission | Result |
| --- | --- | --- |
| `workspace.readFile(path, options?)` | `workspace.read` | `{path, content, revision}` |
| `workspace.listFiles(path = '', options?)` | `workspace.read` | Array of `{path, kind: 'file' \| 'directory', revision?}` |
| `workspace.writeFile(path, content, {expectedRevision, signal?, timeoutMs?})` | `workspace.write` | `{path, revision}` |
| `backends.invoke(id, input, options?)` | `backend.invoke` | Bounded `JsonValue` |

`options` means `{signal?, timeoutMs?}`. Paths use workspace-relative `/`
separators without absolute roots, backslashes, colons, control characters,
empty segments or `.`/`..`. Only listing accepts `''` for the root. The portable
parser checks syntax; the host port owns containment, symlink policy and the
actual allowed root. Listings have unique relative paths, at most 1,000 entries,
and results must stay under a requested directory. File results must echo the
requested path.

Writes require an explicit compare-and-swap expectation:

```js
const saved = await context.workspace.readFile('notes.txt', {signal});
const changed = await context.workspace.writeFile('notes.txt', 'Updated\n', {
  expectedRevision: saved.revision, signal,
});
const created = await context.workspace.writeFile('new-note.txt', 'New\n', {
  expectedRevision: null, signal,
});
```

`null` means create an absent file only. An existing file requires the revision
returned by a read. The port must enforce CAS and return `conflict` after a
mismatch; the portable host cannot enforce a filesystem transaction itself.
Core revisions are opaque strings of 1–128 code points. The supplied Node
workspace uses SHA-256 of exact UTF-8 bytes and has a stricter path policy;
see [WORKSPACES](WORKSPACES.md) and the [wire protocol](workspace-protocol.md).

The host configures `backends: {name: handler}`. A handler receives
`(input, {signal, pluginId, scope})` and returns JSON. The plugin chooses only a
configured name; it cannot provide an executable, URL or shell command through
this API. The Node adapter separately supports operator-configured tools.

## Diagnostics

A selector is `{languages: ['plaintext'], priority?: 0}`. Priority ranges from
-100 to 100. Highest priority wins, followed by the earliest active registration.
`provideDiagnostics(request, {signal})` returns a result or promise. The request
contains `{protocolVersion: 1, requestId, scope, snapshot}`, with snapshot
`{uri, languageId, modelVersion, workspaceRevision, text}`.

The URI identifies supplied document text; it grants no access to that resource.
`modelVersion` is a positive safe integer. Scope/request/revision strings have
at most 128 Unicode code points. Use `createDiagnosticsResult(request, items)`
to echo the identity without document text:

```js
return createDiagnosticsResult(request, [{
  range: {start: {line: 0, character: 0}, end: {line: 0, character: 4}},
  severity: 'info', message: 'Resolve this TODO.', code: 'todo', source: 'example',
}]);
```

Positions use zero-based lines and UTF-16 code-unit offsets. Severity is `error`,
`warning`, `info` or `hint`; messages are plain text. The host checks identity,
ordered ranges and endpoints against the supplied CRLF/LF/CR document. Edits,
document switches and revision changes invalidate pending results.

## Host methods and validators

`createPluginHost({hostId?, scope?, grants?, workspace?, backends?})` returns a
trusted in-process `PluginHost`. `hostId` defaults to `test-host`; `scope`
defaults to `example-project` / `example-session`. Methods are `activate`,
`setDocument`, `requestDiagnostics`, `requestLanguage`, `listPlugins`, `listCommands`,
`executeCommand`, `deactivate` and `dispose`. See [host-contract](host-contract.md)
and [testing](testing.md) for runnable host use.

`parseManifest`, `parseDiagnosticsRequest` and `parseDiagnosticsResult` accept
plain objects or JSON text. `parseDocumentSnapshot` and
`parseCommandDefinition` accept plain data objects. `parseJsonValue` validates
a JSON value rather than parsing text. `parseWorkspacePath` checks path syntax.
All structured outputs are independent frozen copies. Runtime checks reject
unexpected fields and unsupported object shapes without invoking getters or
caller `toJSON` hooks.

| Exported `LIMITS` value | Limit |
| --- | --- |
| `manifestBytes`, `commandBytes` | 16,384 compact UTF-8 JSON bytes each |
| `requestBytes`, `resultBytes` | 1,600,000 UTF-8 JSON bytes each |
| `documentBytes`, `jsonBytes` | 262,144 UTF-8 bytes each |
| `maxDiagnostics`, `maxLanguageItems`, `messageLength` | 500 diagnostics or language items; 2,048 code points per diagnostic message |
| `maxRegistrations`, `maxCommands` | 32 active plugins/providers/backend handlers; 64 commands per host |
| `maxPendingRequests`, `maxFiles` | 64 per registry/host operation group; 1,000 listed entries |
| `jsonDepth`, `jsonNodes` | Depth 16; 10,000 visited JSON nodes |
| `jsonArrayItems`, `jsonObjectProperties` | 1,000 array items; 128 fields per object |
| `defaultTimeoutMs`, `maxTimeoutMs` | 5,000 ms default/activation; 30,000 ms maximum request |

JSON text budgets count original whitespace. Object budgets use only validated
copies. JSON Schema 2020-12 files under `schemas/` describe shapes; runtime
parsers additionally enforce UTF-8 totals, license expression grammar,
request/result identity, ranges and parameter semantics.

## Cancellation and errors

Check the supplied `AbortSignal` before work and between asynchronous steps.
Cancellation settles a host request and discards late results. It cannot stop a
blocking loop, undo a completed write or revoke ambient process APIs. Activation
has a fixed 5-second deadline; request `timeoutMs` must be an integer 1–30,000.

Catch `PluginSdkError` and inspect `code`:

| Code | Meaning |
| --- | --- |
| `invalid_contract` | Invalid fields, parameters, ranges, options or activation return |
| `permission_denied` | A required effective grant is absent |
| `unsupported_host`, `version_mismatch` | Host or diagnostics protocol incompatibility |
| `cancelled`, `stale_snapshot` | Caller cancelled, or document identity changed |
| `budget_exceeded` | Input/output/concurrency limit or timeout |
| `disposed` | Plugin, registration or host removed |
| `provider_failed`, `provider_unavailable` | Plugin failed, or no matching provider exists |
| `capability_unavailable` | No named command/backend or workspace port exists |
| `conflict` | Host port rejected a stale file revision |

Plugin exception details are masked by the host. Trusted port `PluginSdkError`
codes are preserved with a safe message. The Node wire protocol uses its own
`WorkspaceError` vocabulary; see [workspace-protocol](workspace-protocol.md).
