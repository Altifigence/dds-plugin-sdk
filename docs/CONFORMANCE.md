# Host and plugin conformance

The browser-safe `@altifigence/dds-plugin-sdk/conformance` export runs versioned
synthetic contract probes against operator-supplied adapters. It reports every
known feature as `supported`, `unsupported` or `failed`, with exact host/version,
runtime/platform identity, a stable check ID, duration and cleanup status. JSON
readback is strict and has a published schema. A report is test evidence, not
publisher authentication, a sandbox certificate or DDS product qualification.

```js
import {runConformance, formatConformanceReport}
  from '@altifigence/dds-plugin-sdk/conformance';
import {createPluginHost} from '@altifigence/dds-plugin-sdk';
const report = await runConformance({
  identity: {host: 'My host', version: '1.0.0', runtime: 'Node 24', platform: 'linux-x64'},
  features: ['commands', 'permissions', 'cancellation'],
  adapters: {host: options => createPluginHost(options)},
});
console.log(formatConformanceReport(report));
```

Replace that factory with your host adapter. It receives the standard
`PluginHostOptions` and must return a fresh host, including the supplied permission,
workspace, settings, backend, runtime and storage ports. The suite supplies a real
plugin; callbacks returning `{ok:true}` cannot establish conformance. Plugin authors
run their own plugin's tests in addition to these host probes.

The three core cases are required by default. Optional cases run only when explicitly
declared; a declared capability with a missing/broken adapter fails. Unknown optional
declarations are recorded and never probed. `requiredFeatures` can require a chosen
profile. A report with zero failures can still have unsupported features; inspect the
full matrix, not only `ok`.

## Adapters and coverage

| Port | Probes and independent fixture |
| --- | --- |
| `host(options)` | Commands and structured input/output, unknown capability rejection, intersected grants and operator scope, revoke, cooperative cancellation with unsettled-slot retention; hover generation/malformed response; formatting proposal freshness; folding identity; jobs/idempotence; storage recovery/history/current authority |
| `settings(definition)` | Default/user/workspace precedence, CAS, failed migration rollback and subscription disposal |
| `workspace({signal})` | Fresh authenticated client; `fixture.txt` contains `alpha 😀\r\nalpha`; `fixture.bin` is the 131089-byte sequence `(index*17+31)&255`. A `conformance-plugin` command `capture` retains text and binary results. Port also provides `artifactSha256`, `journal`, `writeFixture`, `restart`, `revokeProjects`, `revokeUploads`, `dispose` |
| `localization` | Selected locale, explicit fallback and placeholder validation |
| `testing` | Seeded clock, deadline order, payload-free synthetic trace and pure replay identity |
| `diagnostics` | Bounded local reports, body exclusion and pending cleanup, using the supplied host |
| `development()` | Disposable absent directory plus generation/doctor API; deterministic dry-run/generation, missing installation diagnosis, drift and overwrite refusal. No dependency install or plugin execution |

`CONFORMANCE_CASES` links all 0.8–0.13 feature groups to packed examples, including
the larger language assistance/display, crash recovery and browser storage scenarios.
The quick probes sample each contract; the linked examples and release tests cover
the fuller boundary matrix. Native browser OPFS/checkpoint support must be exercised
in an actual browser using `examples/browser-resume`; it is not certified by Node
probes or memory fixtures. Filesystem crash/disk-full behavior likewise requires
the actual Node integration tests, not an in-memory host.

For the complete reference Node profile:

```js
import {runConformance} from '@altifigence/dds-plugin-sdk/conformance';
import {createSdkConformanceOptions} from '@altifigence/dds-plugin-sdk/conformance-node';
const report = await runConformance(createSdkConformanceOptions());
```

The Node helper creates and removes only its fresh synthetic temporary directories,
uses ephemeral loopback servers, and starts no external tool or shell. Its fixture
digest is deliberately synthetic and is not a trusted publisher pin. Its optional
`failNextRequest('disconnect'|'malformed')` is a local test control.

## Deadlines, cleanup and privacy

Case deadlines default to 10 seconds, bounded by 30 seconds. Timeout or cancellation
stops later selected cases. Cleanup is observed and bounded; late factories dispose
resources when they eventually return. `cleanup: pending` means release is unverified,
never that resources were forcibly reclaimed. Adapters and fixtures are trusted
in-process code: a synchronous loop cannot be interrupted and ambient OS access is
not isolated. Run unknown hosts/plugins in an independently isolated process.

Reports store only caller-supplied short identity labels, declared feature IDs and
fixed check/reason fields. Provider errors, stack traces, payloads, tokens and paths
are not exported. Do not put sensitive information in identity labels. Reports are
returned locally and no upload service is contacted.
