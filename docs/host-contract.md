# Implement a host adapter

The public contracts and local test host are available in 0.1.0. DDS Desktop
and Cloud integration is not available in this version. The public repository
owns this versioned SDK contract; adapters consume its reviewed releases.

The local host executes trusted modules in-process. `AbortSignal` settles the
host request and discards late results; it cannot stop a blocking loop or revoke
access to ambient Node APIs. Production execution requires an independently
enforced isolation boundary.

The core export `createDiagnosticsRegistry({isCurrent?})` is a portable lifecycle
helper for trusted host implementers. It offers:

```js
const registry = createDiagnosticsRegistry({
  isCurrent: request => /* compare scope and active snapshot */ true,
});
const registration = registry.register(pluginId, {languages: ['plaintext']}, provider);
const result = await registry.request(validatedRequest, {signal, timeoutMs: 5000});
registry.invalidate(); // abort requests after an edit or document switch
registration.dispose();
registry.dispose();
```

`isCurrent` defaults to `true` for standalone fixtures; real hosts must supply a
comparison and call `invalidate()` when host state changes. The registry bounds
registrations/concurrency, selects providers, forwards cancellation, enforces
timeout, validates results, checks document ranges and discards stale responses.
It does not authorize registration, import a plugin, or establish a sandbox.

A production adapter must separately verify package identity/integrity and host
compatibility; grant only requested, enforceable permissions; supply scoped
active-document snapshots; dispose registrations on disable/unload/replacement;
and enforce code isolation, execution/resource budgets and revocation. Never
add arbitrary process invocation or raw filesystem access to the plugin context.

Qualify installation, activation, edit/switch cancellation, scope/identity checks,
unload/reload, denied grants, timeout and disposal on every advertised host. A
passing local test-host run proves the authoring contract, not DDS product loading.
