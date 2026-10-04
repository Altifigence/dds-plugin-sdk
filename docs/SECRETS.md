# Explicit secret references (SDK 0.12)

The `/secrets` module separates an opaque reference from the material it refers
to. A `SecretReference` is only `{kind: 'dds-secret-reference', id: '<uuid-v4>'}`.
The operator owns `createSecretResolver({resolve, authorize, now?})`, keeps the
actual bytes in a separate provider and issues references for a plugin, workspace,
command allowlist and lifetime. There is no automatic credential discovery.

```js
import {createSecretResolver} from '@altifigence/dds-plugin-sdk/secrets';

const resolver = createSecretResolver({
  authorize: request => operatorStillApproves(request),
  resolve: (request, {signal}) => operatorStore.readBytes(request.secretId, {signal}),
});
const reference = resolver.issue({secretId: 'selected-credential',
  pluginId: 'example', workspaceId: 'selected-project', commandIds: ['send'],
  ttlMs: 60_000});
// Store/pass reference as a field explicitly typed with format:'dds-secret-reference'.
```

Mount it with `createPluginHost({secrets: resolver, grants: ['secrets.resolve']})`
or the automatic `createWorkspaceServer` host. The workspace-runtime manifest
must declare `secrets.resolve`. UI-runtime manifests cannot request this permission.
A command input schema must identify each permitted reference field explicitly.
The handler receives `options.secrets` only when its validated input contains such
references. It cannot resolve a different reference merely by knowing an ID.

```js
// Inside an authorized command handler:
await options.secrets.withSecret(input.token, async (bytes, {signal}) => {
  await callerConfiguredOperation(bytes, {signal});
});
```

Each normal command and job gets a fresh execution ID. The resolver checks the
plugin/workspace/command scope, reference expiry, revocation and current operator
authorization before and after resolution and after the callback. A callback
must return `undefined`, not secret material. It receives an SDK-owned copy of
provider bytes; that copy is zeroed on cancellation and on every exit. Provider
and callback errors are replaced with safe SDK errors, without their message or
cause. A reference is permission metadata, not proof that the provider will agree
to supply material on a later call.

`revoke(reference)` and `dispose()` abort active leases and prevent new access.
Expiry also aborts leases. Closing the command execution or deactivating its plugin
invalidates the execution API, including a saved copy retained by a handler.
Work that ignores cancellation still occupies the resolver's actual pending slot
until it settles. Cancellation cannot undo an external side effect already made.
The command can perform other work before requesting its secret; place the lease
before any effect that depends on that authorization.

Independent hosts can call `createSecretExecution(resolver, scope, reviewedRefs,
{signal})`, use its `secrets.withSecret`, and always dispose it in `finally`.
Custom resolver ports are trusted operator code and must enforce equivalent
authorization, bounds and byte-lifetime rules. The execution adapter confines the
reference list and sanitizes port errors; it cannot enforce internals of a custom
provider or prevent that provider from retaining material.

The bundled resolver limits references to 128, command IDs to 32 per reference,
concurrent actual leases to 8 and each material value to 16 KiB. Default lifetime
is 60 seconds; maximum is one hour. Leases use the normal 5-second timeout with a
30-second maximum and are additionally bounded by reference expiry. `inspect()`
returns counts only. The optional clock is for operator-controlled tests.

This is an in-process SDK, not an OS security boundary. Trusted callbacks can copy
or deliberately disclose bytes; the SDK cannot erase copies it does not own.
Provider-owned bytes are not cleared for the provider. Ordinary settings strings,
plugin logs/results and arbitrary application data cannot be automatically
classified as secrets. Never place real material in manifests, bundles, fixtures,
settings, logs or result objects. The public example generates disposable material
in memory, reports only an authorization boolean and clears its own provider buffer.
