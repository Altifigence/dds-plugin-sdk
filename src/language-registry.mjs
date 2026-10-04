import {parseProviderSelector, parseLanguageRequest, parseLanguageResult, assertLanguageResultMatchesRequest, createLanguageResult, LANGUAGE_FEATURES} from './contracts.mjs';
import {LANGUAGE_LIMITS, parseCompletionItem, completionInsertion} from './language-assistance.mjs';
import {languageObject, languageInteger, invalidLanguage, freezeLanguage} from './language-values.mjs';
import {ErrorCode, LIMITS, PluginSdkError} from './limits.mjs';
import {hostRuntime} from './host-runtime.mjs';
import {parseCodeAction, sameCodeActionSelection, validateFormattingEdit} from './language-editing.mjs';
import {LANGUAGE_DISPLAY_LIMITS as displayLimits, parseSemanticTokensDelta, applySemanticTokensDelta} from './language-display.mjs';

const failure = (code, message) => new PluginSdkError(code, message);
const sameRange = (a, b) => ['start', 'end'].every(key => a[key].line === b[key].line && a[key].character === b[key].character);
function providerMethod(provider, name) {
  if (!provider || typeof provider !== 'object') return undefined;
  let owner = provider;
  for (let depth = 0; owner && owner !== Object.prototype && depth < 16; depth++, owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) {if (typeof descriptor.value !== 'function') invalidLanguage('Expected provider data methods'); return descriptor.value;}
  }
  return undefined;
}

/** Trusted host primitive. Plugins remain in-process; grants belong to the owning host. */
export function createLanguageRegistry(kind, {isCurrent = () => true,runtime:runtimeInput} = {}) {
  const runtime=hostRuntime(runtimeInput);
  if (!LANGUAGE_FEATURES.includes(kind) || typeof isCurrent !== 'function') invalidLanguage();
  const registrations = new Set(), live = new Set(), tokens = new Map(), results = new WeakMap(), semantic = new Map();
  const resolvable = kind === 'completion' || kind === 'code-actions';
  let disposed = false, sequence = 0, epoch = 0, tokenBytes = 0, resolving = 0, semanticBytes = 0;
  const open = () => {if (disposed) throw failure(ErrorCode.DISPOSED, 'Language registry is disposed');};
  const current = (request, expectedEpoch = epoch) => {
    open();
    if (epoch !== expectedEpoch || !isCurrent(request)) throw failure(ErrorCode.STALE_SNAPSHOT, 'Language snapshot is no longer current');
  };
  function removeToken(id) {const entry = tokens.get(id); if (entry) {tokenBytes -= entry.bytes; tokens.delete(id);}}
  function purgeTokens() {const now = runtime.now(); for (const [id, entry] of tokens) if (entry.expiresAt <= now || !entry.provider.active) removeToken(id);}
  function clearTokens() {tokens.clear(); tokenBytes = 0;}
  function removeSemantic(id) {const saved = semantic.get(id); if (saved) {semanticBytes -= saved.bytes; semantic.delete(id);}}
  function clearSemantic() {semantic.clear(); semanticBytes = 0;}
  function purgeSemantic() {const now = runtime.now(); for (const [id, saved] of semantic) if (saved.expiresAt <= now || !saved.entry.active) removeSemantic(id);}
  function abortEntry(entry, code) {for (const ticket of live) if (ticket.entry === entry) ticket.controller.abort(failure(code, 'Language provider is no longer active'));}
  function register(pluginId, selector, provider, options = {}) {
    open();
    if (typeof pluginId !== 'string' || !pluginId.length || pluginId.length > 128) invalidLanguage();
    selector = parseProviderSelector(selector); languageObject(options, [], ['resolve', 'snippets', 'semanticDelta']);
    for (const value of Object.values(options)) if (typeof value !== 'boolean') invalidLanguage();
    if (!resolvable && options.resolve || kind !== 'completion' && options.snippets || kind !== 'semantic-tokens' && options.semanticDelta) invalidLanguage();
    const provide = providerMethod(provider, 'provide'), resolve = providerMethod(provider, 'resolve'), provideDelta = providerMethod(provider, 'provideDelta');
    if (!provide) invalidLanguage('Expected provider data methods');
    if (resolve && !options.resolve || options.resolve && !resolve) throw failure(ErrorCode.PERMISSION_DENIED, 'Language resolve needs an explicit capability');
    if (provideDelta && !options.semanticDelta || options.semanticDelta && !provideDelta) throw failure(ErrorCode.PERMISSION_DENIED, 'Semantic delta needs an explicit capability');
    if (registrations.size >= LIMITS.maxRegistrations) throw failure(ErrorCode.BUDGET_EXCEEDED, 'Language provider limit exceeded');
    const entry = {pluginId, selector, provider, provide, resolve, provideDelta, snippets: options.snippets === true, sequence: sequence++, active: true};
    registrations.add(entry);
    return Object.freeze({dispose() {
      if (!entry.active) return;
      entry.active = false; registrations.delete(entry); abortEntry(entry, ErrorCode.DISPOSED);
      for (const [id, token] of tokens) if (token.provider === entry) removeToken(id);
      for (const [id, saved] of semantic) if (saved.entry === entry) removeSemantic(id);
    }});
  }
  async function invoke(entry, request, operation, options = {}, resolution = false) {
    languageObject(options, [], ['signal', 'timeoutMs']);
    const {signal, timeoutMs = LIMITS.defaultTimeoutMs} = options;
    languageInteger(timeoutMs, LIMITS.maxTimeoutMs, 1);
    if (signal !== undefined && !(signal instanceof AbortSignal)) invalidLanguage();
    const generation = epoch; current(request, generation);
    if (!entry.active) throw failure(ErrorCode.DISPOSED, 'Language provider is no longer active');
    if (signal?.aborted) throw failure(ErrorCode.CANCELLED, 'Language request cancelled');
    if (live.size >= LIMITS.maxPendingRequests || resolution && resolving >= LANGUAGE_LIMITS.resolvePending) throw failure(ErrorCode.BUDGET_EXCEEDED, 'Language pending operation limit exceeded');
    const controller = new AbortController(), ticket = {entry, controller};
    live.add(ticket); if (resolution) resolving++;
    const abort = () => controller.abort(failure(ErrorCode.CANCELLED, 'Language request cancelled'));
    signal?.addEventListener('abort', abort, {once: true});
    let onAbort;
    const cancelled = new Promise((_, reject) => {onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, {once: true});});
    const timer = runtime.setTimeout(() => controller.abort(failure(ErrorCode.BUDGET_EXCEEDED, 'Language request timed out')), timeoutMs);
    const operationPromise = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      current(request, generation);
      return operation(Object.freeze({signal: controller.signal}));
    }).catch(error => {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw failure(ErrorCode.PROVIDER_FAILED, 'Language provider failed');
    }).finally(() => {live.delete(ticket); if (resolution) resolving--;});
    try {
      const raw = await Promise.race([operationPromise, cancelled]);
      if (controller.signal.aborted) throw controller.signal.reason;
      current(request, generation);
      if (!entry.active) throw failure(ErrorCode.DISPOSED, 'Language provider is no longer active');
      return raw;
    } finally {
      runtime.clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort);
      // An ignored cancellation retains its live slot until the provider actually settles.
    }
  }
  function checkedResult(raw, request, entry, allowTokens) {
    let result = parseLanguageResult(raw); assertLanguageResultMatchesRequest(result, request);
    if (['format-document', 'format-range'].includes(kind) && !validateFormattingEdit(request, result.data)) result = parseLanguageResult({...result, data: null});
    const additions = []; let bytes = 0;
    if (resolvable) {
      purgeTokens();
      const data = result.data.map(item => {
        if (item.resolveToken !== undefined) invalidLanguage('Providers cannot supply host resolve tokens');
        if (kind === 'completion' && item.insertTextFormat === 'snippet' && !entry.snippets) throw failure(ErrorCode.PERMISSION_DENIED, 'Snippet capability was not declared');
        const {resolveData, ...visible} = item;
        if (resolveData !== undefined && allowTokens) {
          if (!entry.resolve) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE, 'Language resolver is unavailable');
          if (typeof runtime.randomUUID !== 'function') throw failure(ErrorCode.CAPABILITY_UNAVAILABLE, 'Secure token generation is unavailable');
          const id = runtime.randomUUID(), size = new TextEncoder().encode(JSON.stringify({request, item})).byteLength;
          additions.push([id, {provider: entry, request, item, epoch, bytes: size, expiresAt: runtime.now() + LANGUAGE_LIMITS.resolveTtlMs}]); bytes += size;
          visible.resolveToken = id;
        }
        return visible;
      });
      if (tokens.size + additions.length > LANGUAGE_LIMITS.resolveTokens || tokenBytes + bytes > LANGUAGE_LIMITS.resolveBytes) throw failure(ErrorCode.BUDGET_EXCEEDED, 'Language resolve retention limit exceeded');
      result = parseLanguageResult({...result, data});
    }
    for (const [id, entry] of additions) tokens.set(id, entry);
    tokenBytes += bytes; results.set(result, {request, entry, epoch, tokenIds: additions.map(([id]) => id)});
    return result;
  }
  function releaseResult(result) {
    open();
    const saved = results.get(result); if (!saved) return;
    for (const id of saved.tokenIds) removeToken(id);
    if (saved.semanticId) removeSemantic(saved.semanticId);
    results.delete(result);
  }
  function validateResult(result) {
    open(); const saved = results.get(result);
    if (!saved) throw failure(ErrorCode.STALE_SNAPSHOT, 'Language result does not belong to this registry');
    current(saved.request, saved.epoch);
    if (!saved.entry.active) throw failure(ErrorCode.DISPOSED, 'Language provider is no longer active');
    return result;
  }
  async function requestSemantic(request, entry, options = {}) {
    languageObject(options, [], ['signal', 'timeoutMs']);
    const timeoutMs = options.timeoutMs ?? LIMITS.defaultTimeoutMs;
    languageInteger(timeoutMs, LIMITS.maxTimeoutMs, 1);
    const generation = epoch, deadline = performance.now() + timeoutMs;
    const {previousResultId, ...providerFields} = request;
    const providerRequest = parseLanguageRequest(providerFields);
    const call = operation => {
      current(request, generation);
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) throw failure(ErrorCode.BUDGET_EXCEEDED, 'Language request timed out');
      return invoke(entry, request, operation, {...options, timeoutMs: Math.min(timeoutMs, remaining)});
    };
    purgeSemantic();
    const saved = previousResultId ? semantic.get(previousResultId) : undefined;
    const sameBase = saved && saved.entry === entry && saved.scope.projectId === request.scope.projectId && saved.scope.sessionId === request.scope.sessionId && saved.previous.snapshot.uri === request.snapshot.uri && saved.previous.snapshot.languageId === request.snapshot.languageId && saved.previous.snapshot.modelVersion <= request.snapshot.modelVersion;
    let data, updateKind = previousResultId ? 'fallback' : 'full';
    if (sameBase && entry.provideDelta) {
      // Touch the LRU without extending its bounded lifetime.
      semantic.delete(previousResultId); semantic.set(previousResultId, saved);
      const raw = await call(options => entry.provideDelta.call(entry.provider, providerRequest, saved.previous, options));
      current(request, generation);
      if (raw !== null) {
        const delta = parseSemanticTokensDelta(raw);
        if (delta.baseResultId === saved.previous.resultId) {
          data = applySemanticTokensDelta(saved.tokens, delta, request.snapshot.text); updateKind = 'delta';
        }
      }
    }
    if (!data) {
      const raw = await call(options => entry.provide.call(entry.provider, providerRequest, options));
      current(request, generation);
      const parsed = parseLanguageResult(raw); assertLanguageResultMatchesRequest(parsed, request); data = parsed.data;
    }
    if (typeof runtime.randomUUID !== 'function') throw failure(ErrorCode.CAPABILITY_UNAVAILABLE, 'Secure token generation is unavailable');
    const id = runtime.randomUUID(), {text: _text, ...snapshot} = request.snapshot;
    const tokens = freezeLanguage({resultId: data.resultId, legend: data.legend, data: data.data});
    const previous = freezeLanguage({resultId: data.resultId, snapshot, legend: data.legend, data: data.data});
    const bytes = new TextEncoder().encode(JSON.stringify({previous, scope: request.scope})).byteLength;
    if (bytes > displayLimits.semanticCacheBytes) throw failure(ErrorCode.BUDGET_EXCEEDED, 'Semantic retention limit exceeded');
    const result = checkedResult(createLanguageResult(request, {...data, resultId: id, updateKind}), request, entry, false);
    purgeSemantic();
    while (semantic.size >= displayLimits.semanticCacheEntries || semanticBytes + bytes > displayLimits.semanticCacheBytes) removeSemantic(semantic.keys().next().value);
    semantic.set(id, {entry, scope: request.scope, previous, tokens, bytes, expiresAt: runtime.now() + displayLimits.semanticCacheTtlMs}); semanticBytes += bytes;
    results.get(result).semanticId = id;
    return result;
  }
  return Object.freeze({
    inspect(){purgeTokens();purgeSemantic();return Object.freeze({disposed,registrations:registrations.size,pending:live.size,resolving,tokens:tokens.size,tokenBytes,semanticEntries:semantic.size,semanticBytes});},
    register,
    validateResult,
    async request(input, options) {
      open(); const request = parseLanguageRequest(input);
      if (request.kind !== kind) invalidLanguage('Language feature does not match registry');
      const generation = epoch; current(request, generation); purgeTokens();
      const entry = [...registrations].filter(entry => entry.selector.languages.includes(request.snapshot.languageId)).sort((a, b) => b.selector.priority - a.selector.priority || a.sequence - b.sequence)[0];
      if (!entry) throw failure(ErrorCode.PROVIDER_UNAVAILABLE, 'No language provider matches the document');
      if (kind === 'semantic-tokens') {
        const result = await requestSemantic(request, entry, options);
        current(request, generation);
        if (!entry.active) throw failure(ErrorCode.DISPOSED, 'Language provider is no longer active');
        return result;
      }
      const raw = await invoke(entry, request, options => entry.provide.call(entry.provider, request, options), options);
      current(request, generation);
      return checkedResult(raw, request, entry, true);
    },
    async resolve(token, options) {
      open(); purgeTokens();
      if (!resolvable) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE, 'This feature has no resolver');
      if (typeof token !== 'string' || token.length !== 36) invalidLanguage('Invalid completion resolve token');
      const saved = tokens.get(token);
      if (!saved) throw failure(ErrorCode.STALE_SNAPSHOT, 'Completion resolve token is unknown or expired');
      current(saved.request, saved.epoch); removeToken(token);
      const raw = await invoke(saved.provider, saved.request, options => saved.provider.resolve.call(saved.provider.provider, saved.request, saved.item, options), options, true);
      current(saved.request, saved.epoch);
      const item = kind === 'completion' ? parseCompletionItem(raw) : parseCodeAction(raw), previous = saved.item;
      if (kind === 'completion') {
        const initialRange = previous.range ?? {start: saved.request.position, end: saved.request.position};
        const resolvedRange = item.range ?? {start: saved.request.position, end: saved.request.position};
        if (item.label !== previous.label || item.insertText !== previous.insertText || (item.insertTextFormat ?? 'literal') !== (previous.insertTextFormat ?? 'literal') || !sameRange(initialRange, resolvedRange)) invalidLanguage('Completion resolver changed the selected insertion');
      } else if (!sameCodeActionSelection(item, previous)) invalidLanguage('Resolver changed the selected action');
      return checkedResult(createLanguageResult(saved.request, [item]), saved.request, saved.provider, false);
    },
    prepareCompletion(result, itemIndex = 0) {
      open(); if (kind !== 'completion') invalidLanguage();
      const saved = results.get(result);
      if (!saved) throw failure(ErrorCode.STALE_SNAPSHOT, 'Completion result does not belong to this registry');
      current(saved.request, saved.epoch);
      if (!saved.entry.active) throw failure(ErrorCode.DISPOSED, 'Completion provider is no longer active');
      languageInteger(itemIndex, result.data.length - 1);
      return completionInsertion(saved.request, result.data[itemIndex]);
    },
    prepareEdit(result, itemIndex = 0) {
      open();
      if (!['format-document', 'format-range', 'code-actions'].includes(kind)) invalidLanguage();
      const saved = results.get(result);
      if (!saved) throw failure(ErrorCode.STALE_SNAPSHOT, 'Edit result does not belong to this registry');
      current(saved.request, saved.epoch);
      if (!saved.entry.active) throw failure(ErrorCode.DISPOSED, 'Edit provider is no longer active');
      if (kind !== 'code-actions') return result.data;
      languageInteger(itemIndex, result.data.length - 1);
      const item = result.data[itemIndex];
      if (item.disabled || item.edit === undefined) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE, 'Action has no available edit');
      return item.edit;
    },
    releaseCompletion: releaseResult,
    release: releaseResult,
    invalidate(options = {}) {
      languageObject(options, [], ['retainSemantic']);
      if (options.retainSemantic !== undefined && typeof options.retainSemantic !== 'boolean') invalidLanguage();
      open(); epoch++; clearTokens();
      if (!options.retainSemantic) clearSemantic();
      for (const ticket of live) ticket.controller.abort(failure(ErrorCode.STALE_SNAPSHOT, 'Language snapshot is no longer current'));
    },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; clearTokens(); clearSemantic();
      for (const entry of registrations) {entry.active = false; abortEntry(entry, ErrorCode.DISPOSED);}
      registrations.clear();
    },
  });
}
