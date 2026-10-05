# Registered tools and output streams

SDK 1.2's optional `tool-streams` export parses output in Node or a browser. It
has no process/network authority. `tool-streams-node` is a Node-only runner for
fixed operator-approved tools. Both have public declarations and JSON schemas.

```sh
node node_modules/@altifigence/dds-plugin-sdk/examples/workflow-tools/run.mjs
node node_modules/@altifigence/dds-plugin-sdk/examples/tool-streams-browser/serve.mjs
```

The first uses a redistributable SDK-authored synthetic tool. The second serves a
loopback browser page with fragmented UTF-8, progress, diagnostics, unknown output,
literal masking, final partial-line and cancellation examples. Neither downloads
or installs tools. In a checkout, use `npm run example:workflow-tools` and
`npm run example:tool-streams-browser`.

## Portable parser

```js
import {createToolStreamParser} from '@altifigence/dds-plugin-sdk/tool-streams';

const parser = createToolStreamParser({
  format: 'jsonl', jobId, commandId, toolId, toolVersion,
  secrets: knownSensitiveValues, sensitivePaths: operatorPaths,
  signal, onEvent: async event => await consumer.write(event),
});
try {
  for await (const bytes of stdout) await parser.write(bytes, 'stdout');
  const stats = await parser.finish();
} finally { parser.dispose(); }
```

Await each `write` for backpressure, feed stderr with its own stream name, and
`finish()` only after both streams end. Separate fatal UTF-8 decoders retain split
characters and partial lines. JSONL supports `log`, `progress`, `diagnostic` and
`unknown` records. Invalid JSONL/diagnostic lines produce explicit `unknown` events;
malformed UTF-8 or resource limits stop the parser. Plain text becomes log events.
The `typescript` text parser recognizes relative `file(line,column): error TS…`
messages and converts one-based positions to zero-based ranges.

Events carry version, sequence, job, command, tool/version and stdout/stderr
correlation. Diagnostics use relative paths, ordered nonnegative positions,
severity, message and optional code/source. Without source text, a tool stream
cannot prove that a position lies inside the actual document; the consuming host
must validate it against its current snapshot before publishing editor diagnostics.
`createJobToolEventSink(job, {onDiagnostic})` sends progress/logs to an existing
JobReporter and leaves diagnostics with a caller-owned sink.

Masking replaces configured nonempty single-line literal values and paths after
line assembly, including literals split across chunks. It does not detect encoded,
transformed or unknown secrets. Masked diagnostic paths become unknown events.
Do not pass raw sensitive output to an unrelated logger before parsing it.

## Operator registration and execution

`createToolRunner({tools, workspaceRoot, authorize})` accepts registrations with:

- An approved process ID/version, absolute executable, SHA-256, selected artifact
  paths/digests, fixed version-probe arguments/output, explicit environment and
  fixed arguments with typed `{input}` slots.
- A backend ID, closed input data schema, declared relative file input slots,
  output format and parser.

The host owns the whole tool installation and decides which implementation files
must be pinned. The SDK checks the supplied pins and bounded exact version output;
it does not infer a complete dependency tree from an entry script. Argument slots
are required scalar fields; flag/line injection and nonlocal file paths are rejected.
The plugin cannot select an executable or shell through invocation input.

`runner.run({toolId, version, input, jobId, commandId, onEvent, signal})` checks
current authorization before preparation, before start, on every event and after
completion. It uses `shell: false` and only the explicitly supplied environment,
owns the direct child and its pipes, waits for trailing output, and returns a
receipt with state, reason, exit code, signal and parser statistics. Cancellation,
deadlines and `close()` stop owned work; start failures and nonzero exits remain
failures. It does not terminate unrelated processes or discover/kill descendant
process trees. Registered tools are trusted operator code, not sandboxed plugins.

## Tested adapters

| Adapter | Evidence and boundary |
| --- | --- |
| SDK synthetic tool 1.0.0 | Independent JSONL process; normal/nonzero, fragmented UTF-8, trailing line, cancellation, output limits |
| TypeScript 5.9.3 | Actual compiler; `--noEmit --noLib --pretty false`; TS2322 diagnostic from a disposable file with explicit intrinsic types |
| Plain text | Log records only; no tool-specific semantic interpretation |

To run the actual compiler example, supply an existing approved installation:

```sh
node node_modules/@altifigence/dds-plugin-sdk/examples/workflow-tools/run.mjs --typescript-root /absolute/path/to/typescript
```

The example hashes the selected local Node executable and TypeScript files and
checks `Version 5.9.3`. This is an explicit local demonstration, not independent
publisher authentication. Other versions are unsupported until separately verified.
The SDK has zero runtime dependencies; TypeScript and the language server are
development/test dependencies only.

| Resource | Maximum |
| --- | --- |
| UTF-8 chunk / line / complete output | 64 KiB / 16 KiB / 2 MiB |
| Events / queued writes / event callback | 4096 / 8 / 5 seconds |
| Registered tools / concurrent runs | 32 / 4 (default 2) |
| Invocation deadline | 10 minutes (default 60 seconds) |
| Version-probe output / deadline | 16 KiB / 5 seconds |
| Pinned artifacts / size of each | 64 / 256 MiB |

See [workflows](WORKFLOWS.md) to compose steps and [LSP](LSP.md) for stdio language
servers. This release adds no private DDS backend or product installation path.
