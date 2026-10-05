# Public LSP bridge

SDK 1.2's optional Node-only `lsp-node` export connects an operator-approved stdio
server to existing public SDK language contracts. It uses the
[LSP 3.17 protocol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
subset below. It does not claim complete LSP support or DDS product integration.

```sh
node node_modules/@altifigence/dds-plugin-sdk/examples/lsp/run.mjs
```

The redistributable synthetic server implements its own framing independently of
the SDK. The example exercises 15 features, versioned diagnostics, document
lifecycle, unchanged workspace files and owned-process shutdown. In a checkout,
use `npm run example:lsp`.

## Connect and discover

`createLspBridge({process, workspaceRoot, scope, authorize, ...})` takes the same
operator-owned `TrustedProcessDefinition` as [registered tools](TOOL_STREAMS.md).
Its arguments are fixed, pins and exact version probe are checked, and initialization
negotiates UTF-16 positions and full document snapshots. Incremental-only payloads,
nonlocal URIs and servers negotiating another position encoding are unsupported.
The supported server sync kinds are full and incremental; for either, this client
sends full-text changes without a range, which LSP permits.

Call `bridge.capabilities()` for the explicit matrix. An advertised capability
means negotiated availability, not that every possible result shape will work.
`bridge.provider(kind)` can be registered directly with
`context.registerLanguageProvider(kind, selector, provider)`. Alternatively,
`bridge.request(sdkRequest, {signal})` returns the existing SDK language result.
The request includes scope and a current DocumentSnapshot; SDK result validation
remains in force.

| SDK feature | LSP method | Result boundary |
| --- | --- | --- |
| completion | textDocument/completion | Literal items; snippets and resolve unsupported |
| hover | textDocument/hover | Literal text; markup is not rendered as HTML |
| definition / references | textDocument/definition / references | Authorized local locations |
| document-symbols / document-symbol-tree | textDocument/documentSymbol | Flat or hierarchical SDK symbols |
| signature-help | textDocument/signatureHelp | Bounded signatures and active argument |
| prepare-rename / rename | textDocument/prepareRename / rename | Range preview / conditional edit proposal |
| format-document / format-range | textDocument/formatting / rangeFormatting | Conditional edit proposals |
| code-actions | textDocument/codeAction | Literal actions and edit proposals; commands disabled |
| semantic-tokens | textDocument/semanticTokens/full | Negotiated legend and validated full tokens |
| folding-ranges | textDocument/foldingRange | Validated snapshot ranges |
| inlay-hints | textDocument/inlayHint | Literal labels and tooltips |

Unsupported features are explicit: completion resolve/snippets, code-action
resolve, semantic deltas, server commands, dynamic registration, create/rename/delete
resource operations, socket transports and unversioned diagnostics. Unknown server
requests receive unsupported responses; `workspace/applyEdit` returns `applied:false`.
Configuration is a bounded host-supplied object, not arbitrary file/network access.

## Documents, permissions and edits

`syncDocument(snapshot)` sends didOpen/didChange, and `closeDocument(uri)` sends
didClose. File URIs must resolve to the same local workspace without links.
Canonical filesystem paths account for Windows drive-letter casing. Results may
reference another authorized open document or a document supplied by the optional
`readDocument(path, {signal})` host port. That port must return the exact requested
snapshot. Every source and edit target requires current host authorization.

The bridge tracks document versions and a generation. Any synchronized change or
close cancels outstanding work; stale and late responses never become current
results. This conservative generation also cancels unrelated requests when a
document changes. Duplicate active SDK request IDs are rejected. UTF-16 ranges
must fit the relevant snapshot. Edit proposals carry base hashes and use existing
[workspace edit](WORKSPACE_EDITS.md) preview/CAS application; the bridge never
applies edits or executes code-action commands.

`textDocument/publishDiagnostics` must carry the current model version. Unversioned
or stale notifications are dropped and counted. The optional `onDiagnostics`
callback receives an existing SDK DiagnosticsResult after authorization and range
validation. It is bounded by the request timeout. Configure explicit masks for
known sensitive text; literal masking is not general secret detection.

## Lifecycle and limits

`close()` sends didClose, shutdown and exit, then stops its owned direct process
and closes pipes. The receipt distinguishes acknowledged graceful protocol
shutdown from a refused/crashed server and reports actual process closure and
pending requests. A server may acknowledge shutdown but still need the bounded
owned-process stop. Crashes do not trigger an automatic restart or replay. The
operator creates a fresh bridge and resends selected current snapshots explicitly.
Parent cancellation stops the session. The host owns any descendants launched by
its trusted server; the SDK is not a process-tree manager or sandbox.

| Resource | Maximum |
| --- | --- |
| Message body / header | 1 MiB / 8 KiB |
| Session output / messages | 64 MiB / 20,000 |
| Pending requests / queued writes | 16 / 16 |
| Documents / aggregate text bytes | 32 / 4 MiB |
| Request deadline | 30 seconds (default 5 seconds) |
| Initialize deadline | At least 10 seconds, up to the configured request deadline |
| Discarded stderr bytes | 64 KiB, then the session stops |

The framing helpers `encodeLspMessage` and `createLspFrameDecoder` are also public
Node utilities. They use UTF-8 byte lengths, bounded incremental Content-Length
framing and explicit malformed/truncated-frame failures. They do not open a transport.

## Actual TypeScript server example

The tested independent server is the community
[typescript-language-server](https://github.com/typescript-language-server/typescript-language-server)
**5.3.0**, with **TypeScript 5.9.3**. Provide existing approved installations:

```sh
node node_modules/@altifigence/dds-plugin-sdk/examples/lsp/run.mjs --typescript-root /absolute/path/to/typescript --language-server-root /absolute/path/to/typescript-language-server
```

This explicitly enables the real-server example in addition to the synthetic one.
It checks completion, hover, definition, references, symbols, signature help,
formatting and semantic tokens: eight features. The example pins selected local
implementation files and Node, probes the exact server version, fixes tsserver's
path and disables automatic typings acquisition. It does not download dependencies.
The operator must trust the complete server/tool installation and its OS access.

Version 5.3.0 omits optional `initialize.serverInfo` and emits unversioned diagnostics;
the example identifies it through pins/version probe and does **not** claim its
diagnostics work through this bridge. Versioned diagnostics are verified with the
independent synthetic server. Feature support and successful actual-server checks
are reported separately. Other servers and versions require their own acceptance.
