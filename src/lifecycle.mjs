import { assertResultMatchesRequest, parseDiagnosticsRequest, parseDiagnosticsResult, parseProviderSelector } from './contracts.mjs';
export {createLanguageRegistry} from './language-registry.mjs';
import { ErrorCode, LIMITS, PluginSdkError } from './limits.mjs';

const sdkError = (code, message) => new PluginSdkError(code, message);

/** A trusted-host lifecycle primitive. It does not load or isolate plugin code. */
export function createDiagnosticsRegistry({isCurrent = () => true} = {}) {
  return createProviderRegistry({isCurrent, parseRequest: parseDiagnosticsRequest, parseResult: parseDiagnosticsResult, assertMatches: assertResultMatchesRequest, method: 'provideDiagnostics'});
}

function createProviderRegistry({isCurrent, parseRequest, parseResult, assertMatches, method}) {
  if (typeof isCurrent !== 'function') throw sdkError(ErrorCode.INVALID_CONTRACT, 'isCurrent must be a function');
  const registrations = new Set();
  const pending = new Set();
  let disposed = false;
  let sequence = 0;

  function assertOpen() {
    if (disposed) throw sdkError(ErrorCode.DISPOSED, 'Provider registry is disposed');
  }

  function abortEntry(entry, code, message) {
    for (const controller of entry.pending) controller.abort(sdkError(code, message));
  }

  function register(pluginId, selector, provider) {
    assertOpen();
    if (typeof pluginId !== 'string' || !pluginId.length || pluginId.length > 128) throw sdkError(ErrorCode.INVALID_CONTRACT, 'Expected a plugin ID');
    selector = parseProviderSelector(selector);
    if (!provider || typeof provider[method] !== 'function') throw sdkError(ErrorCode.INVALID_CONTRACT, 'Expected provider function');
    if (registrations.size >= LIMITS.maxRegistrations) throw sdkError(ErrorCode.BUDGET_EXCEEDED, 'Provider registration limit exceeded');
    const entry = {pluginId, selector, provider, sequence: sequence++, pending: new Set()};
    registrations.add(entry);
    let active = true;
    return Object.freeze({dispose() {
      if (!active) return;
      active = false;
      registrations.delete(entry);
      abortEntry(entry, ErrorCode.DISPOSED, 'Provider registration is disposed');
    }});
  }

  async function request(value, {signal, timeoutMs = LIMITS.defaultTimeoutMs} = {}) {
    assertOpen();
    const request = parseRequest(value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.maxTimeoutMs) throw sdkError(ErrorCode.INVALID_CONTRACT, 'timeoutMs must be 1..30000');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw sdkError(ErrorCode.INVALID_CONTRACT, 'Expected AbortSignal');
    if (signal?.aborted) throw sdkError(ErrorCode.CANCELLED, 'Provider request cancelled');
    if (!isCurrent(request)) throw sdkError(ErrorCode.STALE_SNAPSHOT, 'Requested document snapshot is no longer current');
    const entry = [...registrations]
      .filter(item => item.selector.languages.includes(request.snapshot.languageId))
      .sort((a, b) => b.selector.priority - a.selector.priority || a.sequence - b.sequence)[0];
    if (!entry) throw sdkError(ErrorCode.PROVIDER_UNAVAILABLE, 'No Provider provider matches the document language');
    if (pending.size >= LIMITS.maxPendingRequests) throw sdkError(ErrorCode.BUDGET_EXCEEDED, 'Pending request limit exceeded');
    const controller = new AbortController();
    pending.add(controller);
    entry.pending.add(controller);
    const abort = () => controller.abort(sdkError(ErrorCode.CANCELLED, 'Provider request cancelled'));
    signal?.addEventListener('abort', abort, {once: true});
    let onAbort;
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, {once: true});
    });
    const timer = setTimeout(() => controller.abort(sdkError(ErrorCode.BUDGET_EXCEEDED, 'Provider request timed out')), timeoutMs);
    try {
      const operation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return entry.provider[method](request, Object.freeze({signal: controller.signal}));
      }).catch(error => {
        if (controller.signal.aborted) throw controller.signal.reason;
        // Do not expose provider exception messages, stack traces or private paths.
        throw sdkError(ErrorCode.PROVIDER_FAILED, 'Provider provider failed');
      });
      const raw = await Promise.race([operation, cancelled]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!isCurrent(request)) throw sdkError(ErrorCode.STALE_SNAPSHOT, 'Requested document snapshot is no longer current');
      const result = parseResult(raw);
      assertMatches(result, request);
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      pending.delete(controller);
      entry.pending.delete(controller);
    }
  }

  return Object.freeze({
    register,
    request,
    invalidate() {
      assertOpen();
      for (const controller of pending) controller.abort(sdkError(ErrorCode.STALE_SNAPSHOT, 'Requested document snapshot is no longer current'));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of registrations) abortEntry(entry, ErrorCode.DISPOSED, 'Provider registry is disposed');
      registrations.clear();
    },
  });
}
