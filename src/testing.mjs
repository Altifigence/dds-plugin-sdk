import { parseDiagnosticsRequest, parseDocumentSnapshot, parseGrants, parseManifest, parseScope } from './contracts.mjs';
import { createDiagnosticsRegistry } from './lifecycle.mjs';
import { ErrorCode, LIMITS, PluginSdkError } from './limits.mjs';

const hostFailures = new WeakSet();
const error = (code, message) => {
  const failure = new PluginSdkError(code, message);
  hostFailures.add(failure);
  return failure;
};

/** Executes trusted local plugins in this process. This developer host is not a sandbox. */
export function createTestHost({scope = {projectId: 'example-project', sessionId: 'example-session'}, grants = ['document.read', 'diagnostics.publish']} = {}) {
  scope = parseScope(scope);
  grants = parseGrants(grants);
  let document;
  let revision = 0;
  let nextRequest = 0;
  let disposed = false;
  const plugins = new Map();
  const registry = createDiagnosticsRegistry({isCurrent(request) {
    return !!document && request.scope.projectId === scope.projectId && request.scope.sessionId === scope.sessionId &&
      ['uri', 'languageId', 'modelVersion', 'workspaceRevision', 'text'].every(key => request.snapshot[key] === document[key]);
  }});

  function assertOpen() { if (disposed) throw error(ErrorCode.DISPOSED, 'Test host is disposed'); }

  function cleanup(state) {
    if (!state.active) return;
    state.active = false;
    state.controller.abort(error(ErrorCode.DISPOSED, 'Plugin deactivated'));
    for (const registration of state.registrations) registration.dispose();
    state.registrations.clear();
    // Host-owned registrations are always cleaned even if a plugin's disposer throws.
    const disposable = state.disposable;
    state.disposable = undefined;
    if (disposable) {
      try { disposable.dispose(); } catch { /* provider cleanup cannot restore host registrations */ }
    }
  }

  async function activate(plugin) {
    assertOpen();
    const manifest = parseManifest(plugin?.manifest);
    if (typeof plugin?.activate !== 'function') throw error(ErrorCode.INVALID_CONTRACT, 'Expected a plugin activation function');
    if (!manifest.supportedHosts.includes('test-host')) throw error(ErrorCode.UNSUPPORTED_HOST, 'Plugin does not support test-host');
    if (plugins.has(manifest.id)) throw error(ErrorCode.INVALID_CONTRACT, 'Plugin ID is already active');
    if (plugins.size >= LIMITS.maxRegistrations) throw error(ErrorCode.BUDGET_EXCEEDED, 'Active plugin limit exceeded');
    const effectiveGrants = Object.freeze(grants.filter(grant => manifest.permissions.includes(grant)));
    const state = {active: true, registrations: new Set(), controller: new AbortController(), disposable: undefined};
    plugins.set(manifest.id, state);
    const context = Object.freeze({
      host: Object.freeze({id: 'test-host', version: '0.1.0', protocolVersion: 1}),
      pluginId: manifest.id,
      scope,
      grants: effectiveGrants,
      signal: state.controller.signal,
      registerDiagnosticsProvider(selector, provider) {
        assertOpen();
        if (!state.active) throw error(ErrorCode.DISPOSED, 'Plugin is deactivated');
        if (!effectiveGrants.includes('document.read') || !effectiveGrants.includes('diagnostics.publish')) {
          throw error(ErrorCode.PERMISSION_DENIED, 'Diagnostics require document.read and diagnostics.publish grants');
        }
        let registration;
        try { registration = registry.register(manifest.id, selector, provider); }
        catch (failure) {
          throw error(failure instanceof PluginSdkError ? failure.code : ErrorCode.PROVIDER_FAILED, 'Diagnostics provider registration failed');
        }
        state.registrations.add(registration);
        return Object.freeze({dispose() {
          registration.dispose();
          state.registrations.delete(registration);
        }});
      },
    });
    const signal = state.controller.signal;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, {once: true});
    });
    const timer = setTimeout(() => state.controller.abort(error(ErrorCode.BUDGET_EXCEEDED, 'Plugin activation timed out')), LIMITS.defaultTimeoutMs);
    const operation = Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return plugin.activate(context);
    }).then(result => {
      if (result !== undefined && (!result || typeof result.dispose !== 'function')) throw error(ErrorCode.INVALID_CONTRACT, 'Activation must return a Disposable or undefined');
      if (!state.active || disposed || signal.aborted) {
        if (result) { try { result.dispose(); } catch { /* host already closed */ } }
        throw signal.reason ?? error(ErrorCode.DISPOSED, 'Plugin deactivated during activation');
      }
      return result;
    });
    try {
      const result = await Promise.race([operation, aborted]);
      // Disposal can run between the operation's resolution and this continuation.
      if (!state.active || disposed || signal.aborted) {
        if (result) { try { result.dispose(); } catch { /* host already closed */ } }
        throw signal.reason ?? error(ErrorCode.DISPOSED, 'Plugin deactivated during activation');
      }
      state.disposable = result;
      return Object.freeze({dispose() {
        cleanup(state);
        if (plugins.get(manifest.id) === state) plugins.delete(manifest.id);
      }});
    } catch (failure) {
      cleanup(state);
      if (plugins.get(manifest.id) === state) plugins.delete(manifest.id);
      if (hostFailures.has(failure)) throw failure;
      throw error(ErrorCode.PROVIDER_FAILED, 'Plugin activation failed');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  return Object.freeze({
    activate,
    setDocument(value) {
      assertOpen();
      const updated = parseDocumentSnapshot(value);
      if (document && document.uri === updated.uri && document.workspaceRevision === updated.workspaceRevision &&
          updated.modelVersion <= document.modelVersion &&
          (updated.text !== document.text || updated.languageId !== document.languageId)) {
        throw error(ErrorCode.INVALID_CONTRACT, 'Changed document requires a newer modelVersion or workspaceRevision');
      }
      registry.invalidate();
      document = updated;
      revision++;
      return updated;
    },
    async requestDiagnostics(options = {}) {
      assertOpen();
      if (!document) throw error(ErrorCode.INVALID_CONTRACT, 'Set a document before requesting diagnostics');
      const currentRevision = revision;
      const result = await registry.request(parseDiagnosticsRequest({protocolVersion: 1, requestId: `request-${++nextRequest}`, scope, snapshot: document}), options);
      if (currentRevision !== revision) throw error(ErrorCode.STALE_SNAPSHOT, 'Document changed while diagnostics were pending');
      return result;
    },
    deactivate(pluginId) {
      assertOpen();
      const state = plugins.get(pluginId);
      if (state) { cleanup(state); plugins.delete(pluginId); }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of plugins.values()) cleanup(state);
      plugins.clear();
      registry.dispose();
      document = undefined;
    },
  });
}
