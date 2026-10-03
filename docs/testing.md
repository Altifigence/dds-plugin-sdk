# Test your plugin

The `testing` subpath exports `createTestHost({scope?, grants?})`. Defaults are
the example project/session and both diagnostics permissions. Import your own
plugin directly; the host never follows a manifest entry path.

Create `plugin.test.mjs` next to your `plugin.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestHost } from '@altifigence/dds-plugin-sdk/testing';
import plugin from './plugin.mjs';

test('TODO diagnostics clear after a document edit', async () => {
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

| Method | Behavior |
| --- | --- |
| `await host.activate(plugin)` | Return a plugin `Disposable`; reject and roll back failed/cancelled activation |
| `host.setDocument(snapshot)` | Validate/freeze a copy, abort old requests and replace the active document |
| `await host.requestDiagnostics({signal?, timeoutMs?})` | Dispatch to the selected provider and validate its response |
| `host.deactivate(pluginId)` | Remove a plugin and abort its activation/requests |
| `host.dispose()` | Abort and remove everything; repeated calls are safe |

For the same URI and workspace revision, changed text or language requires a
newer `modelVersion`. Updating the document, switching its URI, or changing the
workspace revision invalidates pending diagnostics. Caller cancellation returns
`cancelled`; document changes return `stale_snapshot`; provider or host disposal
returns `disposed`. A provider that never finishes is subject to a timeout, and
late results cannot reach the consumer.

Add tests for missing grants, cancellation, invalid output and plugin reload.
The repository's `tests/` contains examples of each. `npm run pack:check` installs
the actual packed tarball outside the source tree and runs the example, runtime
consumer and TypeScript consumer against that installed package.
