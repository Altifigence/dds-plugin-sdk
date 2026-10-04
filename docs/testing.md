# Test your plugin

Use Node.js 22 or 24 and the built-in `node:test` runner. Runtime checks below
need no external dependencies. `npm ci` in a repository clone installs the
pinned TypeScript development tool for the separate declaration checks.

`createTestHost({scope?, grants?})` from the `testing` subpath is the compatibility
helper: it uses `test-host`, the example project/session and both diagnostics
grants by default. `createPluginHost()` from the core accepts workspace/backend
ports and defaults to no grants. Both run explicitly imported trusted modules
in-process; neither follows a manifest entry or establishes an OS sandbox.

## Deterministic scenarios (0.13)

`createScenarioHost()` from `/testing` defaults to no grants or mounted file,
backend, settings, secret or job capability. Select each explicitly:

```js
const scenario = createScenarioHost({
  seed: 7, start: 1000,
  files: {'result.txt': 'synthetic example'},
  backends: {analyzer: {count: 3}},
  grants: ['workspace.read', 'backend.invoke'],
  jobs: true, binaryArtifacts: true,
});
try {
  // Activate your trusted plugin on scenario.host.
  scenario.faults.enqueue({operation: 'backend.analyzer', kind: 'delay', delayMs: 25});
  const pending = scenario.host.executeCommand('your-plugin', 'analyze', {});
  await scenario.clock.advance(25);
  const result = await pending;
} finally {
  await scenario.dispose();
  scenario.assertClean();
}
```

Await `clock.advance()` before awaiting an operation blocked on its virtual timer.
`createTestClock({seed,start})` exposes a trusted `runtime` port containing `now`,
`setTimeout`, `clearTimeout` and `randomUUID`. Core host/diagnostic/language/job
lifecycles, resolve-cache expiry, job checkpoint/history clocks, settings migrations
and secret leases can use this port without patching globals. Test UUIDs are
deterministic and are **not cryptographic production entropy**. The existing
`now` secret-resolver option remains available but cannot be combined with `runtime`.

Read-only resource `inspect()` methods remain available after disposal, including
settings-store inspection (new in 0.13). Data reads and mutations still reject a
disposed owner. This lets teardown checks observe a provider that ignored abort
until it actually settles instead of reporting it as already released.

Equal-time timers run in registration order. Each advance has at most 10,000
steps and 4,096 scheduled timers; concurrent advances fail. An advance accepts
at most one day, and drains bounded microtask turns between callbacks.
`flushTestMicrotasks(turns)` helps settle explicitly bounded promise chains.
Real I/O, WebCrypto completion, arbitrary plugin timers, OS watchers/processes
and network transports are not made virtual. Do not call `runUntilIdle()` for a
deliberately repeating timer without a suitable finite step budget.

`scenario.capabilities` lists mounted fixtures. `replaceGrants(next)` deactivates
plugins losing any grant, cancels their pending work and changes subsequent
activations; newly added grants apply when a plugin next activates. These are
operator controls, never a plugin API. Mounting a fixture does not grant access.

| Fixture | Contract and limit |
| --- | --- |
| `createMemoryWorkspace` / `scenario.workspace` | UTF-8 reads, exact revision CAS writes, bounded lists, immutable binary sources and parsed project snapshots; 256 files, 256 KiB/file, 4 MiB total |
| Workspace `subscribe` | Explicit synthetic snapshot callback; no native filesystem watching; 32 subscriptions |
| Scenario `backends` | Named JSON fixture responses; explicit `backend.invoke` grant |
| Scenario `settings` | Real bounded `SettingsStore` validation/CAS/migration with virtual operation timers; explicit supplied definitions |
| Scenario `secrets` | Explicit synthetic byte arrays with real scoped resolver leases, virtual expiry and owned-copy zeroing |
| `createMemoryJobStore` | Checksummed bounded contract snapshots, CAS and synthetic unavailable/corrupt records; no disk durability claim |

Faults are queued for `file.read`, `file.write`, `file.list`, `file.capture`,
`file.chunk`, `backend.<name>`, `settings.read`, `secret.resolve` or `store.write`.
`delay` requires `delayMs`; `deny`, `disconnect`, `drop` and `exhaust` simulate
their corresponding failure. `corrupt` returns the explicitly supplied JSON
value without executing the real fixture operation. A dropped operation waits
for cancellation or fault-controller disposal. `faults.events()` can drop,
duplicate or reverse returned fixture events; it never duplicates actual effects.
Standalone ports/controllers remain owner-managed. Attach an external job store
via `jobStorage` and await `host.flushJobStore()` before inspecting its checkpoints.

`scenario.inspect()` and `host.inspect()` count actual owned work, including
pending activation/provider operations that ignored cancellation. Disposal cannot
stop that code; `assertClean()` fails until it really settles. `createTestResources`
tracks only explicitly registered file handles, processes, subscriptions, timers
or operations. Supply their cleanup callback, retain failed cleanup entries and
call `assertEmpty()`. It does not discover unrelated operating-system handles.
The scenario's fake clock is also inspectable after disposal so leaked fixture
timers are not silently hidden by clearing them.

## Synthetic trace recording and pure replay

```js
const fixtures = {
  synthetic: true, seed: 7, fixtureVersion: 1,
  fixtures: [{id: 'greeting', operation: 'command',
    input: {name: 'Example'}, output: {message: 'Hello, Example!'}}],
};
const recorder = createTestRecorder({...fixtures, now: scenario.clock.now});
recorder.record('greeting', {name: 'Example'}, {message: 'Hello, Example!'});
const trace = recorder.snapshot();
const replay = createTestReplay(trace, fixtures);
const result = replay.next('greeting', {name: 'Example'});
replay.assertComplete();
```

Recording requires the caller's explicit assertion that every selected fixture is
synthetic. The trace contains only its schema/fixture version, seed, selected
fixture IDs, fixed operation names, virtual time, ordered input/output hashes and
a hash chain. It contains no raw payloads, paths or secret bytes. Fixture IDs must
also be non-sensitive. A hash is not encryption or anonymization: low-entropy
values may be guessable. Keep customer, credential and PDK data out of fixtures.
The SDK cannot establish that caller-provided material is actually synthetic.

`parseTestTrace` checks exact fields, at most 1,024 events/1 MiB, sequence and hash
integrity. Replay checks the seed, fixture version, complete fixture digest and
request order, then returns the supplied frozen synthetic response. It accepts
no execution callback and performs no filesystem/backend/secret effects. Job-store
snapshots are separate full contract checkpoints and are not privacy-filtered
trace exports; their default persisted job content policy remains metadata-only.

Run `npm run example:devtools` for language, workspace, backend, settings, secrets,
binary jobs and trace/profiler examples. Memory restart/corruption fixtures do not
replace the separate real killed-child, HTTP, filesystem and browser examples.

## Test the included diagnostics plugin

In a clone of the SDK repository, save `plugin.test.mjs` at the repository root:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHost } from '@altifigence/dds-plugin-sdk/testing';
import plugin from './examples/hello-diagnostics/plugin.mjs';

test('TODO diagnostics clear after an edit', async () => {
  const host = createTestHost();
  try {
    await host.activate(plugin);
    const snapshot = {
      uri: 'memory:///test.txt', languageId: 'plaintext',
      modelVersion: 1, workspaceRevision: 'one', text: 'TODO',
    };
    host.setDocument(snapshot);
    assert.equal((await host.requestDiagnostics()).diagnostics.length, 1);
    host.setDocument({...snapshot, modelVersion: 2, text: 'Done'});
    assert.equal((await host.requestDiagnostics()).diagnostics.length, 0);
  } finally {
    host.dispose();
  }
});
```

```sh
node --test plugin.test.mjs
```

For your own package, import `./plugin.mjs` instead. Supply both explicit
diagnostics grants to `createPluginHost()` when using it directly.

## Test commands, parameters and a workspace port

This complete fixture uses an in-memory workspace and a named backend. Save it
as `workspace.test.mjs` in the repository root or a package with the SDK installed:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginHost, definePlugin, ErrorCode, PluginSdkError }
  from '@altifigence/dds-plugin-sdk';

const manifest = {
  manifestVersion: 2, id: 'notes-plugin', name: 'Notes', publisher: 'example',
  version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs',
  runtime: 'workspace', capabilities: ['commands'],
  permissions: ['workspace.read', 'workspace.write', 'backend.invoke'],
  supportedHosts: ['test-host'], license: 'Apache-2.0',
  source: {visibility: 'open', licenseFile: './LICENSE'},
};

test('a command writes only against the saved revision', async () => {
  let saved = {path: 'notes.txt', content: 'draft', revision: 'r1'};
  const host = createPluginHost({
    grants: manifest.permissions,
    workspace: {
      readFile(path) {
        assert.equal(path, saved.path);
        return saved;
      },
      listFiles() { return [{path: saved.path, kind: 'file', revision: saved.revision}]; },
      writeFile(path, content, {expectedRevision, signal}) {
        signal.throwIfAborted();
        assert.equal(path, saved.path);
        if (expectedRevision !== saved.revision) {
          throw new PluginSdkError(ErrorCode.CONFLICT, 'Revision changed');
        }
        saved = {path, content, revision: 'r2'};
        return {path, revision: saved.revision};
      },
    },
    backends: {uppercase: input => ({text: input.text.toUpperCase()})},
  });
  const plugin = definePlugin(manifest, context => context.registerCommand({
    id: 'save', title: 'Save notes',
    parameters: [{name: 'text', label: 'Text', type: 'string', required: true}],
  }, async (input, {signal}) => {
    const file = await context.workspace.readFile('notes.txt', {signal});
    const value = await context.backends.invoke('uppercase', input, {signal});
    return context.workspace.writeFile(file.path, value.text, {
      expectedRevision: file.revision, signal,
    });
  }));
  try {
    await host.activate(plugin);
    assert.equal(host.listCommands()[0].id, 'save');
    assert.deepEqual(await host.executeCommand('notes-plugin', 'save', {text: 'ready'}),
      {path: 'notes.txt', revision: 'r2'});
    assert.equal(saved.content, 'READY');
    await assert.rejects(host.executeCommand('notes-plugin', 'save', {}),
      error => error.code === ErrorCode.INVALID_CONTRACT);
    host.deactivate('notes-plugin');
    assert.equal(host.listCommands().length, 0);
  } finally {
    host.dispose();
  }
});
```

```sh
node --test workspace.test.mjs
```

The fixture port enforces its own revision check. Test a stale expectation,
`expectedRevision: null` for create-only writes, and host-side denied grants in
your actual adapter. Use the supplied [Node workspace](WORKSPACES.md) to test
real saved files and the authenticated client protocol.

## Lifecycle and failure cases

| Host method | Expected behavior |
| --- | --- |
| `await activate(plugin)` | Compatibility and manifest validation; failed activation rolls back registrations |
| `setDocument(snapshot)` | Validate/copy the active text and invalidate pending diagnostics |
| `await requestDiagnostics(options?)` | Selected provider; identity and document-range checks |
| `listPlugins()`, `listCommands()` | Metadata from completed active plugins only |
| `await executeCommand(pluginId, commandId, input, options?)` | Validate parameters and bounded JSON result |
| `deactivate(pluginId)` | Abort pending work and remove all registrations |
| `dispose()` | Remove everything; repeated calls are safe |

Changed text or language for the same URI/revision requires a newer
`modelVersion`. Edits, URI switches and workspace revision changes invalidate
diagnostics. Caller abort yields `cancelled`, a replaced document yields
`stale_snapshot`, disposal yields `disposed`, and a timeout yields
`budget_exceeded`. Late results never reach the consumer. An ignored signal
cannot undo an external side effect or stop a blocking loop.

Cover missing effective grants, failed/slow activation, duplicate IDs,
command registration disposal, stale document results, invalid parameter types,
unknown command/backend, malformed port output, CAS conflicts, timeout and
reload. See the repository's `tests/` for implementation fixtures.

## Repository checks

```sh
npm test
npm run example
npm run example:theme
npm run schemas:check
npm run test:types
npm run pack:check
```

`npm test` uses the built-in runner. Schema checks detect generated schema drift;
type checks use the pinned TypeScript tool. `pack:check` installs the actual
tarball outside the source tree and checks consumers against that package.
Theme tests also verify that the included XML and browser preview match the
exporter. Public CI runs the supported Node versions; qualify native DDS
installation and connection separately from these source/package checks.
