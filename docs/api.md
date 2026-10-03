# API reference — 0.1.0

Import values and types from `@altifigence/dds-plugin-sdk`. All ranges use
zero-based lines and UTF-16 code-unit offsets, as JavaScript strings do. Messages
are plain text.

## Declare a plugin

`definePlugin(manifest, activate)` validates and freezes a copy of the manifest.
It returns `{manifest, activate}`. The host calls `activate(context)`; return a
`Disposable` with `dispose()` or return nothing. Async activation is supported.

```js
import { createDiagnosticsResult, definePlugin } from '@altifigence/dds-plugin-sdk';

export default definePlugin({
  manifestVersion: 1,
  id: 'my-diagnostics',
  name: 'My Diagnostics',
  publisher: 'example',
  version: '0.1.0',
  protocolVersion: 1,
  entry: './plugin.mjs',
  capabilities: ['diagnostics'],
  permissions: ['document.read', 'diagnostics.publish'],
  supportedHosts: ['test-host'],
  license: 'Apache-2.0',
}, context => context.registerDiagnosticsProvider({languages: ['plaintext']}, {
  provideDiagnostics(request, {signal}) {
    signal.throwIfAborted();
    return createDiagnosticsResult(request, []);
  },
}));
```

All manifest fields in the example are required. Unknown fields, permissions,
capabilities and hosts are rejected. IDs, publisher and language IDs use lower
case letters, digits and `.`, `_`, `-` separators; IDs start with a letter.
`version` follows SemVer, including optional prerelease/build suffixes.
`entry` is a relative `.mjs` path without directory traversal. It is metadata:
the test host takes an explicitly imported plugin and does not load `entry`.
`license` is a single SPDX-style identifier; license eligibility is the plugin
publisher's responsibility.

## Activation context

| Member | Meaning |
| --- | --- |
| `host` | `{id: 'test-host', version: '0.1.0', protocolVersion: 1}` |
| `pluginId` | Validated manifest ID |
| `scope` | Opaque `{projectId, sessionId}` assigned by the host |
| `grants` | Immutable subset of declared permissions granted by the host |
| `signal` | Aborted on deactivation, host disposal or activation timeout |
| `registerDiagnosticsProvider(selector, provider)` | Register and receive an idempotent `Disposable` |

Registering diagnostics requires both `document.read` and `diagnostics.publish`
in the manifest **and** in the host's granted permissions. A declaration never
grants itself authority. The context provides no file, process, network, account
or workspace service API.

A selector is `{languages: ['plaintext'], priority: 0}`. Priority is optional,
defaults to zero and ranges from -100 to 100. The host selects one matching
provider: highest priority first, then earliest still-active registration.
Disposing the registration removes it and aborts its pending requests.

## Diagnostics provider

`provideDiagnostics(request, {signal})` returns a `DiagnosticsResult` or a promise
of one. Check `signal` before work and between asynchronous steps. Late results
are discarded even when a provider ignores the signal.

```js
// Host-supplied, immutable request
{
  protocolVersion: 1,
  requestId: 'request-1',
  scope: { projectId: 'example-project', sessionId: 'example-session' },
  snapshot: {
    uri: 'memory:///hello.txt',
    languageId: 'plaintext',
    modelVersion: 1,
    workspaceRevision: 'example-1',
    text: 'TODO',
  },
}
```

The snapshot contains only the supplied active document. A URI is an identity,
not a grant to read that resource. `modelVersion` is a positive safe integer;
`workspaceRevision` is an opaque nonempty string. Scope identifiers, request IDs
and revisions have a maximum length of 128 Unicode code points.

Use `createDiagnosticsResult(request, diagnostics)` to copy the identity into a
validated immutable result. The result echoes protocol, request ID, scope, URI,
language, model version and workspace revision; it omits document text.

```js
return createDiagnosticsResult(request, [{
  range: { start: {line: 0, character: 0}, end: {line: 0, character: 4} },
  severity: 'info',
  message: 'Resolve this TODO.',
  code: 'todo',             // optional, at most 128 code points
  source: 'my-diagnostics', // optional, at most 128 code points
}]);
```

Severity is `error`, `warning`, `info` or `hint`. The result parser checks range
ordering; the host also checks that every endpoint fits the requested document.
Line breaks are CRLF, LF or CR. No diagnostic can target another document.

## Parsers and budgets

`parseManifest`, `parseDiagnosticsRequest` and `parseDiagnosticsResult` accept a
plain data object or JSON string. `parseDocumentSnapshot` accepts a plain object.
They return validated, deeply frozen copies and throw `PluginSdkError` on failure.
Unknown fields, sparse arrays, accessors, symbols and custom prototypes are
rejected. Pass plain JSON data rather than live application objects.

| Exported `LIMITS` value | Limit |
| --- | --- |
| `manifestBytes` | 16,384 UTF-8 JSON bytes |
| `requestBytes`, `resultBytes` | 1,600,000 UTF-8 JSON bytes each |
| `documentBytes` | 262,144 UTF-8 bytes |
| `maxDiagnostics` | 500 per result |
| `messageLength` | 2,048 Unicode code points per message |
| `maxRegistrations` | 32 providers in a registry, 32 active plugins in the test host |
| `maxPendingRequests` | 64 per registry |
| `defaultTimeoutMs` | 5,000 ms; also the test host's activation limit |
| `maxTimeoutMs` | 30,000 ms for a diagnostics request |

Object input is checked against the same aggregate byte budget using the
validated copy's compact JSON. JSON text also counts its original whitespace.
The schemas under `schemas/` are JSON Schema 2020-12. Runtime validation additionally
enforces aggregate UTF-8 byte budgets, range ordering and
request/result identity. Use the runtime parsers at a host boundary.

## Errors

Catch `PluginSdkError` and inspect `error.code` using exported `ErrorCode` values.

| Code | Action |
| --- | --- |
| `invalid_contract` | Fix malformed fields, ranges, options or activation return value |
| `permission_denied` | Request explicit host grants for the declared permissions |
| `unsupported_host` | Select a supported host adapter |
| `version_mismatch` | Match protocol version 1 |
| `cancelled` | Stop work; the caller cancelled |
| `stale_snapshot` | Request again with the current document |
| `budget_exceeded` | Reduce input/output/concurrency, or finish within the timeout |
| `disposed` | The plugin, registration or host was removed |
| `provider_failed` | Inspect the provider locally; host errors omit exception details |
| `provider_unavailable` | Register a provider matching the document language |

`unsupported_host` is reserved for adapter compatibility checks; version 0.1.0
accepts only `test-host` in manifests. Production host IDs require a future
contract update and host acceptance.
