# Operator-owned settings (SDK 0.12)

The `/settings` module provides a bounded **memory** store for one plugin's
versioned definition. The operator owns writes, migrations, persistence and
disposal. Plugins receive a read-only port when the operator mounts that store.
This module does not write files, sync accounts or update DDS product preferences.

```js
import {createSettingsStore} from '@altifigence/dds-plugin-sdk/settings';
import {createPluginHost} from '@altifigence/dds-plugin-sdk';

const definition = {schemaVersion: 1, pluginId: 'example', version: 1, settings: {
  count: {schema: {schemaVersion: 1, schema: {
    type: 'integer', minimum: 1, maximum: 10, default: 2,
  }}, scopes: ['user', 'workspace'], display: {label: 'Count'}},
}};
const store = createSettingsStore(definition);
store.update({workspaceId: 'selected-project', scope: 'workspace',
  expectedRevision: 0, values: {count: 4}});
const host = createPluginHost({
  scope: {projectId: 'selected-project', sessionId: 'selected-session'},
  settings: {example: store}, grants: ['settings.read'],
});
// A v2 plugin must also declare capability 'settings' and permission 'settings.read'.
// Its context.settings.read() returns this plugin/project's effective snapshot.
```

Every setting uses the shared [data schema](DATA_SCHEMAS.md). Effective values
replace a whole key in the order **default < user < workspace**; nested objects
are not recursively merged. `read(workspaceId)` returns frozen `values`, matching
`sources`, the plugin/workspace IDs, `definitionVersion` and `revision`. A setting
without a default or an override is absent. `readOnly: true` requires a valid
default and `scopes: []`; writable settings need at least one allowed scope.

`update({workspaceId, scope, expectedRevision, values?, reset?})` validates the
entire transaction before committing. `reset` lists keys to remove from that
layer, revealing the next available value. A key cannot appear in both `values`
and `reset`. Unknown/deleted keys and writes outside a key's declared scope are
rejected. No-op writes do not advance the revision. A single store-wide revision
makes CAS conservative: a change in another workspace can also cause `conflict`.
Read the current revision and let the caller review/retry the intended edit.

`subscribe(workspaceId, listener)` returns a disposable subscription. The store
coalesces synchronous writes into a microtask notification of the latest view.
Unsubscription before delivery is honored; failing listeners cannot corrupt the
store or another listener. The host validates plugin/workspace identity for each
read and notification, and removes its subscriptions on plugin deactivation.
Closing the host does not dispose a caller-owned store.

`migrate(nextDefinition, callback, {expectedRevision, signal?, timeoutMs?})` is an
explicit transaction. The next version must increase and retain the same plugin
ID. The callback receives a frozen prior export and returns `{user, workspaces}`.
The store validates every resulting layer before its final CAS. A failed callback,
invalid value, stale revision, cancellation or timeout preserves the existing
definition and state. Unknown or removed keys must be handled by that callback;
they are never silently dropped. One actual migration can be pending at a time,
including after a callback ignores cancellation. Run untrusted migration code
outside this trusted in-process host.

`exportState()` returns plain data for operator-managed persistence. Import with
`createSettingsStore(definition, {state})`; plugin and definition versions must
match exactly. Persistence, encryption and crash durability remain the operator's
responsibility. Store exports can contain opaque secret references, never values
resolved by the separate [secret port](SECRETS.md). Arbitrary strings can still
contain sensitive content if a caller puts it there.

Limits: 64 keys, 32 workspace layers, 64 KiB per layer/definition, 256 KiB per
effective snapshot, 1 MiB total exported state and 64 subscriptions. All validation
and expanded defaults must fit their shared schema budgets. Migration timeout is
5 seconds by default, up to 30 seconds. `dispose()` closes the store and cancels
pending migrations; late results cannot commit.

`createWorkspaceServer({settings: {[pluginId]: store}})` configures the automatic
plugin host. With a supplied `pluginHost`, configure its ports yourself. Settings
are accessed by workspace plugins through their context; this release adds no
remote settings-write method. A separate module export such as `settingsDefinition`
lets an operator review definitions before activation, as shown in
[`examples/configuration`](../examples/configuration/plugin.mjs).
