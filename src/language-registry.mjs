import {parseProviderSelector, parseLanguageRequest, parseLanguageResult, assertLanguageResultMatchesRequest, createLanguageResult, LANGUAGE_FEATURES} from './contracts.mjs';
import {LANGUAGE_LIMITS, parseCompletionItem, completionInsertion} from './language-assistance.mjs';
import {languageObject, languageInteger, invalidLanguage} from './language-values.mjs';
import {ErrorCode, LIMITS, PluginSdkError} from './limits.mjs';
import {parseCodeAction, sameCodeActionSelection, validateFormattingEdit} from './language-editing.mjs';

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
export function createLanguageRegistry(kind, {isCurrent = () => true} = {}) {
  if (!LANGUAGE_FEATURES.includes(kind) || typeof isCurrent !== 'function') invalidLanguage();
  const registrations = new Set(), live = new Set(), tokens = new Map(), results = new WeakMap();
  const resolvable = kind === 'completion' || kind === 'code-actions';
  let disposed = false, sequence = 0, epoch = 0, tokenBytes = 0, resolving = 0;
  const open = () => {if (disposed) throw failure(ErrorCode.DISPOSED, 'Language registry is disposed');};
  const current = (request, expectedEpoch = epoch) => {
    open();
    if (epoch !== expectedEpoch || !isCurrent(request)) throw failure(ErrorCode.STALE_SNAPSHOT, 'Language snapshot is no longer current');
  };
  function removeToken(id) {const entry = tokens.get(id); if (entry) {tokenBytes -= entry.bytes; tokens.delete(id);}}
  function purgeTokens() {const now = Date.now(); for (const [id, entry] of tokens) if (entry.expiresAt <= now || !entry.provider.active) removeToken(id);}
  function clearTokens() {tokens.clear(); tokenBytes = 0;}
  function abortEntry(entry, code) {for (const ticket of live) if (ticket.entry === entry) ticket.controller.abort(failure(code, 'Language provider is no longer active'));}
  function register(pluginId, selector, provider, options = {}) {
    open();
    if (typeof pluginId !== 'string' || !pluginId.length || pluginId.length > 128) invalidLanguage();
    selector = parseProviderSelector(selector); languageObject(options, [], ['resolve', 'snippets']);
    for (const value of Object.values(options)) if (typeof value !== 'boolean') invalidLanguage();
    if (!resolvable && options.resolve || kind !== 'completion' && options.snippets) invalidLanguage();
    const provide = providerMethod(provider, 'provide'), resolve = providerMethod(provider, 'resolve');
    if (!provide) invalidLanguage('Expected provider data methods');
    if (resolve && !options.resolve || options.resolve && !resolve) throw failure(ErrorCode.PERMISSION_DENIED, 'Language resolve needs an explicit capability');
    if (registrations.size >= LIMITS.maxRegistrations) throw failure(ErrorCode.BUDGET_EXCEEDED, 'Language provider limit exceeded');
    const entry = {pluginId, selector, provider, provide, resolve, snippets: options.snippets === true, sequence: sequence++, active: true};
    registrations.add(entry);
    return Object.freeze({dispose() {
      if (!entry.active) return;
      entry.active = false; registrations.delete(entry); abortEntry(entry, ErrorCode.DISPOSED);
      for (const [id, token] of tokens) if (token.provider === entry) removeToken(id);
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
    const timer = setTimeout(() => controller.abort(failure(ErrorCode.BUDGET_EXCEEDED, 'Language request timed out')), timeoutMs);
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
      clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort);
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
          if (typeof globalThis.crypto?.randomUUID !== 'function') throw failure(ErrorCode.CAPABILITY_UNAVAILABLE, 'Secure token generation is unavailable');
          const id = globalThis.crypto.randomUUID(), size = new TextEncoder().encode(JSON.stringify({request, item})).byteLength;
          additions.push([id, {provider: entry, request, item, epoch, bytes: size, expiresAt: Date.now() + LANGUAGE_LIMITS.resolveTtlMs}]); bytes += size;
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
    results.delete(result);
  }
  return Object.freeze({
    register,
    async request(input, options) {
      open(); const request = parseLanguageRequest(input);
      if (request.kind !== kind) invalidLanguage('Language feature does not match registry');
      const generation = epoch; current(request, generation); purgeTokens();
      const entry = [...registrations].filter(entry => entry.selector.languages.includes(request.snapshot.languageId)).sort((a, b) => b.selector.priority - a.selector.priority || a.sequence - b.sequence)[0];
      if (!entry) throw failure(ErrorCode.PROVIDER_UNAVAILABLE, 'No language provider matches the document');
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
    invalidate() {
      open(); epoch++; clearTokens();
      for (const ticket of live) ticket.controller.abort(failure(ErrorCode.STALE_SNAPSHOT, 'Language snapshot is no longer current'));
    },
    dispose() {
      if (disposed) return;
      disposed = true; epoch++; clearTokens();
      for (const entry of registrations) {entry.active = false; abortEntry(entry, ErrorCode.DISPOSED);}
      registrations.clear();
    },
  });
}
