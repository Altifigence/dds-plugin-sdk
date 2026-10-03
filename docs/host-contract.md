# Implement and connect a plugin host

SDK 0.3.0 supplies a portable host for trusted modules and a separate public
Node workspace adapter. `createPluginHost()` dispatches explicit plugin API
calls. The Node adapter scopes saved-file operations to an operator-selected
root and can expose them through the authenticated workspace protocol. See
[WORKSPACES](WORKSPACES.md) for the runnable server, client and configured tools.

Both execute trusted code in the user's environment. The portable core imports
no Node filesystem, process or network APIs. It also supplies no OS sandbox:
`AbortSignal` settles requests and drops late results but cannot stop a blocking
loop or remove a module's ambient access. Choose the OS user, container, WSL
environment or other execution boundary independently.

## Portable host

```js
import { createPluginHost } from '@altifigence/dds-plugin-sdk';

const host = createPluginHost({
  hostId: 'workspace-host',
  scope: {projectId: 'my-project', sessionId: 'local-session'},
  grants: ['workspace.read', 'workspace.write', 'backend.invoke'],
  workspace: {
    readFile: (path, {signal}) => selectedWorkspace.read(path, {signal}),
    listFiles: (path, {signal}) => selectedWorkspace.list(path, {signal}),
    writeFile: (path, content, {expectedRevision, signal}) =>
      selectedWorkspace.write(path, content, {expectedRevision, signal}),
  },
  backends: {
    summarize: (input, {signal, pluginId, scope}) =>
      approvedService.summarize(input, {signal, pluginId, scope}),
  },
});
await host.activate(explicitlyImportedPlugin);
const commands = host.listCommands();
const result = await host.executeCommand(commands[0].pluginId, commands[0].id, input);
host.dispose();
```

`selectedWorkspace`, `approvedService`, the imported plugin and command input
are host-owned values in this adapter sketch. The [testing guide](testing.md)
contains a complete runnable in-memory host.

The host defaults to `test-host`, an example scope and **no grants**. It verifies
manifest compatibility before activation. Effective grants are the intersection
of configured host grants and requested manifest permissions. A v2 `ui` plugin
cannot declare workspace/backend permissions; v1 retains diagnostics-only
compatibility. Runtime metadata does not relocate or isolate execution.

Diagnostics registration requires both effective diagnostics grants and its
capability. Language registration requires the specific feature capability plus
`document.read` and `language.provide`; see [LANGUAGE](LANGUAGE.md).
Commands require a declared commands capability. Workspace reads and
lists require `workspace.read`; writes require `workspace.write`; backend calls
require `backend.invoke`. Missing ports fail with `capability_unavailable`.
The host validates all port results and applies cancellation, timeouts and JSON
budgets. Ports still own root containment, filesystem safety, CAS, service
authorization and revocation at their actual resource boundary.

Activation has a 5-second deadline and rolls back registrations on failure.
Only completed activation appears in `listPlugins()` and `listCommands()`.
Deactivation, activation-disposable disposal and host disposal abort requests
and remove registrations. Cleanup is idempotent. A plugin's returned disposer
cannot restore a removed registration.

## Node workspace and client

The `workspace-node` subpath implements `createNodeWorkspace`,
`createWorkspaceServer` and `createProcessBackend`; it uses Node APIs outside
the portable core. The operator selects an absolute root, plugins, artifact
hashes, grants, backend executable/arguments and notice. HTTP requests cannot
supply plugin module paths, arbitrary shell strings or a replacement root.

The server authenticates an operator token, binds the workspace UUID and a
fresh server generation, and advertises configured plugin/command metadata.
Saved-file reads use UTF-8 content identities; writes require CAS. The supplied
`workspace-client` validates protocol replies and provides list/read/write,
management and named-command calls. Its `WorkspaceClient` API differs from the
portable `PluginContext.workspace`; consult [WORKSPACES](WORKSPACES.md) and
[workspace-protocol](workspace-protocol.md) for exact methods and limits.

Use [PUBLISHING](PUBLISHING.md) to inspect an immutable plugin package and
[CONSENT](CONSENT.md) to bind acceptance to notices, workspace identity and
artifacts. Open and closed source plugins share the same permission checks;
license metadata and an artifact hash are not grants or malware assessments.
DDS account tokens, compute reservations and installation authority are not
provided by these APIs.

## Diagnostics-only adapters

`createDiagnosticsRegistry({isCurrent?})` remains available for a host that
already owns its plugin context and permissions:

```js
const registry = createDiagnosticsRegistry({
  isCurrent: request => compareCurrentScopeAndSnapshot(request),
});
const registration = registry.register(pluginId, {languages: ['plaintext']}, provider);
const result = await registry.request(validatedRequest, {signal, timeoutMs: 5000});
registry.invalidate();
registration.dispose();
registry.dispose();
```

`isCurrent` defaults to `true` for standalone fixtures. Real hosts supply a
comparison and invalidate when documents or scope change. The registry bounds
providers and concurrency, selects one matching provider, forwards cancellation,
validates results/ranges and discards stale responses. It does not authorize
registration or import modules.

## DDS release boundary

SDK 0.4.0 command jobs require `jobs: true`, use the same effective permissions,
and have a separate bounded execution lifetime. Bind them to the host scope and
generation, retain admission slots for unsettled work, abort on unload/close,
and render progress/logs as text. The HTTP reference host owns its plugin host
when enabling jobs. See [JOBS](JOBS.md) for terminal state, retention and result
file rules. Dev child processes provide cleanup, not OS isolation.

The public Node server/client and local tests demonstrate user-owned workspace
operations. Native DDS connection controls belong to the DDS product and need
their own release evidence. An SDK tarball or passing local host test does not
establish that a particular installed Desktop/Cloud build loads arbitrary
plugins, displays a workspace connection, or has completed signed installation
qualification. XML theme import is an existing separate product path described
in [THEMES](THEMES.md).

For a DDS adapter, verify package identity and compatibility, scoped document
capture, effective grants, consent, replacement/unload cleanup, cancellation,
stale identities, denied calls, port CAS and resource enforcement on the exact
advertised build. Report native product acceptance separately from SDK and
Node workspace test results.
