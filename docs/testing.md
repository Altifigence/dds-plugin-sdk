# Test your plugin

Use Node.js 22 or 24 and the built-in `node:test` runner. Runtime checks below
need no external dependencies. `npm ci` in a repository clone installs the
pinned TypeScript development tool for the separate declaration checks.

`createTestHost({scope?, grants?})` from the `testing` subpath is the compatibility
helper: it uses `test-host`, the example project/session and both diagnostics
grants by default. `createPluginHost()` from the core accepts workspace/backend
ports and defaults to no grants. Both run explicitly imported trusted modules
in-process; neither follows a manifest entry or establishes an OS sandbox.

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
