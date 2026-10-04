import {storageEqual} from './job-storage-validation.mjs';
import { parseCommandDefinition, parseCommandInput, parseDiagnosticsRequest, parseDocumentSnapshot, parseExpectedRevision, parseFileContent, parseGrants, parseJsonValue, parseManifest, parseScope, parseWorkspaceList, parseWorkspacePath, parseWorkspaceRead, parseWorkspaceWrite } from './contracts.mjs';
import { createDiagnosticsRegistry } from './lifecycle.mjs';
import { createLanguageRegistry } from './lifecycle.mjs';
import { LANGUAGE_FEATURES, parseLanguageRequest } from './contracts.mjs';
import {LANGUAGE_LIMITS} from './language-assistance.mjs';
import {SDK_VERSION} from './version.mjs';
import { ErrorCode, LIMITS, PluginSdkError } from './limits.mjs';
import {createJobRegistry} from './job-registry.mjs';
import {parseBinaryArtifactSource, parseBinaryChunk,parseBinaryArtifactRange,decodeBinaryArtifactData} from './artifacts.mjs';
import {parseStoredArtifact,parseStoredArtifactReference,parseStoredArtifactChunk} from './artifact-storage.mjs';
import {parseJobId, parseJobOptions} from './jobs.mjs';

const hostFailures = new WeakSet();
const error = (code, message) => {
  const failure = new PluginSdkError(code, message);
  hostFailures.add(failure);
  return failure;
};

/** Executes trusted local plugins in this process. This developer host is not a sandbox. */
export function createPluginHost({hostId = 'test-host', scope = {projectId: 'example-project', sessionId: 'example-session'}, grants = [], workspace, backends = {}, jobs = false, binaryArtifacts = false, jobStorage} = {}) {
  if (!['test-host', 'workspace-host'].includes(hostId)) throw error(ErrorCode.UNSUPPORTED_HOST, 'Unknown plugin host');
  scope = parseScope(scope);
  grants = parseGrants(grants);
  if (workspace !== undefined && (!workspace || typeof workspace !== 'object')) throw error(ErrorCode.INVALID_CONTRACT, 'Expected a workspace port');
  if (!backends || typeof backends !== 'object' || Array.isArray(backends) || ![Object.prototype, null].includes(Object.getPrototypeOf(backends))) throw error(ErrorCode.INVALID_CONTRACT, 'Expected named backend handlers');
  const backendMap = new Map();
  for (const name of Reflect.ownKeys(backends)) {
    const descriptor = Object.getOwnPropertyDescriptor(backends, name);
    if (typeof name !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(name) || name.length > 128 || !descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw error(ErrorCode.INVALID_CONTRACT, 'Invalid named backend handler');
    backendMap.set(name, descriptor.value);
  }
  if (backendMap.size > LIMITS.maxRegistrations) throw error(ErrorCode.BUDGET_EXCEEDED, 'Backend handler limit exceeded');
  let document;
  let revision = 0;
  let nextRequest = 0;
  let disposed = false;
  let commandCount = 0;
  const plugins = new Map();
  const pending = new Set();
  if (typeof binaryArtifacts !== 'boolean') throw error(ErrorCode.INVALID_CONTRACT, 'Invalid binary artifact capability');
  const jobRegistry = createJobRegistry({scope, enabled: jobs, binaryArtifacts: binaryArtifacts && typeof workspace?.captureBinaryFile === 'function', jobStorage});
  function isCurrent(request) {
    return !!document && request.scope.projectId === scope.projectId && request.scope.sessionId === scope.sessionId &&
      ['uri', 'languageId', 'modelVersion', 'workspaceRevision', 'text'].every(key => request.snapshot[key] === document[key]);
  }
  const registry = createDiagnosticsRegistry({isCurrent});
  const languages = new Map(LANGUAGE_FEATURES.map(kind => [kind, createLanguageRegistry(kind, {isCurrent})]));

  function assertOpen() { if (disposed) throw error(ErrorCode.DISPOSED, 'Plugin host is disposed'); }
  function assertActive(state) { assertOpen(); if (!state.active || state.controller.signal.aborted) throw error(ErrorCode.DISPOSED, 'Plugin is deactivated'); }
  function permit(state, permission) {
    assertActive(state);
    if (!state.grants.includes(permission)) throw error(ErrorCode.PERMISSION_DENIED, 'Required plugin permission was not granted');
  }
  function checkedOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw error(ErrorCode.INVALID_CONTRACT, 'Expected request options');
    for (const key of Reflect.ownKeys(options)) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!['signal', 'timeoutMs', 'expectedRevision'].includes(key) || !descriptor || !('value' in descriptor) || !descriptor.enumerable) throw error(ErrorCode.INVALID_CONTRACT, 'Invalid request options');
    }
    const {signal, timeoutMs = LIMITS.defaultTimeoutMs} = options;
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw error(ErrorCode.INVALID_CONTRACT, 'Expected AbortSignal');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > LIMITS.maxTimeoutMs) throw error(ErrorCode.INVALID_CONTRACT, 'timeoutMs must be 1..30000');
    return {signal, timeoutMs};
  }
  async function run(state, operation, options, {entry, validate = parseJsonValue, trusted = false} = {}) {
    assertActive(state);
    const {signal, timeoutMs} = checkedOptions(options);
    if (signal?.aborted) throw error(ErrorCode.CANCELLED, 'Plugin operation cancelled');
    if (pending.size >= LIMITS.maxPendingRequests) throw error(ErrorCode.BUDGET_EXCEEDED, 'Pending operation limit exceeded');
    const controller = new AbortController();
    pending.add(controller); entry?.pending.add(controller);
    const abortCaller = () => controller.abort(error(ErrorCode.CANCELLED, 'Plugin operation cancelled'));
    const abortPlugin = () => controller.abort(error(ErrorCode.DISPOSED, 'Plugin deactivated'));
    signal?.addEventListener('abort', abortCaller, {once: true});
    state.controller.signal.addEventListener('abort', abortPlugin, {once: true});
    let onAbort;
    const aborted = new Promise((_, reject) => {onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, {once: true});});
    const timer = setTimeout(() => controller.abort(error(ErrorCode.BUDGET_EXCEEDED, 'Plugin operation timed out')), timeoutMs);
    try {
      const operationPromise = Promise.resolve().then(() => {
        assertActive(state);
        if (controller.signal.aborted) throw controller.signal.reason;
        return operation(controller.signal);
      }).catch(failure => {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (hostFailures.has(failure)) throw failure;
        if (trusted && failure && typeof failure === 'object') {
          const mappings = {invalid_request: ErrorCode.INVALID_CONTRACT, unsafe_path: ErrorCode.INVALID_CONTRACT, unavailable: ErrorCode.CAPABILITY_UNAVAILABLE, not_found: ErrorCode.CAPABILITY_UNAVAILABLE};
          const code = Object.getOwnPropertyDescriptor(failure, 'code');
          if (code && 'value' in code) {
            const mapped = Object.values(ErrorCode).includes(code.value) ? code.value : Object.hasOwn(mappings, code.value) ? mappings[code.value] : undefined;
            if (mapped) throw error(mapped, 'Host port operation failed');
          }
        }
        throw error(ErrorCode.PROVIDER_FAILED, 'Plugin operation failed');
      });
      const result = await Promise.race([operationPromise, aborted]);
      assertActive(state);
      if (controller.signal.aborted) throw controller.signal.reason;
      return validate(result);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abortCaller);
      state.controller.signal.removeEventListener('abort', abortPlugin);
      controller.signal.removeEventListener('abort', onAbort);
      pending.delete(controller); entry?.pending.delete(controller);
    }
  }

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
    if (!manifest.supportedHosts.includes(hostId)) throw error(ErrorCode.UNSUPPORTED_HOST, 'Plugin does not support this host');
    if (plugins.has(manifest.id)) throw error(ErrorCode.INVALID_CONTRACT, 'Plugin ID is already active');
    if (plugins.size >= LIMITS.maxRegistrations) throw error(ErrorCode.BUDGET_EXCEEDED, 'Active plugin limit exceeded');
    const effectiveGrants = Object.freeze(grants.filter(grant => manifest.permissions.includes(grant)));
    const state = {active: true, ready: false, manifest, grants: effectiveGrants, commands: new Map(), registrations: new Set(), controller: new AbortController(), disposable: undefined};
    plugins.set(manifest.id, state);
    const context = Object.freeze({
      host: Object.freeze({id: hostId, version: SDK_VERSION, protocolVersion: 1}),
      pluginId: manifest.id,
      scope,
      grants: effectiveGrants,
      signal: state.controller.signal,
      registerDiagnosticsProvider(selector, provider) {
        assertOpen();
        if (!state.active) throw error(ErrorCode.DISPOSED, 'Plugin is deactivated');
        if (!manifest.capabilities.includes('diagnostics')) throw error(ErrorCode.PERMISSION_DENIED, 'Diagnostics capability was not declared');
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
      registerLanguageProvider(kind, selector, provider) {
        permit(state, 'document.read'); permit(state, 'language.provide');
        if (!languages.has(kind)) throw error(ErrorCode.INVALID_CONTRACT, 'Unknown language feature');
        if (!manifest.capabilities.includes(kind)) throw error(ErrorCode.PERMISSION_DENIED, 'Language capability was not declared');
        let registration;
        try { registration = languages.get(kind).register(manifest.id, selector, provider, {
          resolve: kind === 'completion' && manifest.capabilities.includes('completion-resolve'),
          snippets: kind === 'completion' && manifest.capabilities.includes('completion-snippets'),
        }); }
        catch (failure) { throw error(failure instanceof PluginSdkError ? failure.code : ErrorCode.PROVIDER_FAILED, 'Language provider registration failed'); }
        state.registrations.add(registration);
        return Object.freeze({dispose() {
          registration.dispose(); state.registrations.delete(registration);
        }});
      },
      registerCommand(metadata, handler) {
        assertActive(state);
        if (!manifest.capabilities.includes('commands')) throw error(ErrorCode.PERMISSION_DENIED, 'Commands capability was not declared');
        let command;
        try { command = parseCommandDefinition(metadata); }
        catch (failure) { throw error(failure instanceof PluginSdkError ? failure.code : ErrorCode.PROVIDER_FAILED, 'Command registration failed'); }
        if (typeof handler !== 'function') throw error(ErrorCode.INVALID_CONTRACT, 'Expected a command handler');
        if (state.commands.has(command.id)) throw error(ErrorCode.INVALID_CONTRACT, 'Command ID is already registered for this plugin');
        if (commandCount >= LIMITS.maxCommands) throw error(ErrorCode.BUDGET_EXCEEDED, 'Command registration limit exceeded');
        const entry = {command, handler, pending: new Set(), active: true};
        state.commands.set(command.id, entry); commandCount++;
        const registration = Object.freeze({dispose() {
          if (!entry.active) return;
          entry.active = false; state.commands.delete(command.id); commandCount--;
          for (const controller of entry.pending) controller.abort(error(ErrorCode.DISPOSED, 'Command registration is disposed'));
          state.registrations.delete(registration);
        }});
        state.registrations.add(registration);
        return registration;
      },
      workspace: Object.freeze({
        readFile(path, options = {}) {
          permit(state, 'workspace.read'); path = parseWorkspacePath(path);
          if (!workspace || typeof workspace.readFile !== 'function') throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Workspace read port is unavailable');
          return run(state, signal => workspace.readFile(path, Object.freeze({signal})), options, {validate: value => parseWorkspaceRead(value, path), trusted: true});
        },
        writeFile(path, content, options) {
          permit(state, 'workspace.write'); path = parseWorkspacePath(path); content = parseFileContent(content);
          if (!options || !Object.hasOwn(options, 'expectedRevision')) throw error(ErrorCode.INVALID_CONTRACT, 'expectedRevision is required for writes');
          const expectedRevision = parseExpectedRevision(options.expectedRevision);
          if (!workspace || typeof workspace.writeFile !== 'function') throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Workspace write port is unavailable');
          return run(state, signal => workspace.writeFile(path, content, Object.freeze({expectedRevision, signal})), options, {validate: value => parseWorkspaceWrite(value, path), trusted: true});
        },
        listFiles(path = '', options = {}) {
          permit(state, 'workspace.read'); path = parseWorkspacePath(path, {allowRoot: true});
          if (!workspace || typeof workspace.listFiles !== 'function') throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Workspace list port is unavailable');
          return run(state, signal => workspace.listFiles(path, Object.freeze({signal})), options, {validate: value => parseWorkspaceList(value, path), trusted: true});
        },
      }),
      backends: Object.freeze({invoke(id, input, options = {}) {
        permit(state, 'backend.invoke');
        if (typeof id !== 'string' || !backendMap.has(id)) throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Named backend is unavailable');
        const value = parseJsonValue(input);
        return run(state, signal => backendMap.get(id)(value, Object.freeze({signal, pluginId: manifest.id, scope})), options, {trusted: true});
      }}),
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
      state.ready = true;
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

  function startCommandJob(pluginId, commandId, input, options, attemptOf) {
    assertOpen();
    const state = plugins.get(pluginId);
    if (!state || !state.active || !state.ready) throw error(ErrorCode.DISPOSED, 'Plugin is not active');
    const entry = state.commands.get(commandId);
    if (!entry) throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Command is unavailable');
    const value = parseCommandInput(input, entry.command);
    return jobRegistry.start({pluginId, commandId, input: value, options, attemptOf, grants: state.grants, signal: state.controller.signal,
      assertActive: () => {assertActive(state); if (state.commands.get(commandId) !== entry) throw error(ErrorCode.DISPOSED, 'Command is disposed');},
      assertRead: () => permit(state, 'workspace.read'),
      execute: (input, options) => entry.handler(input, Object.freeze(options)),
      registerController: controller => {entry.pending.add(controller); return () => entry.pending.delete(controller);},
      readFile: (path, signal, timeoutMs = LIMITS.defaultTimeoutMs) => {
        permit(state, 'workspace.read');
        if (!workspace || typeof workspace.readFile !== 'function') throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Workspace read port is unavailable');
        return run(state, signal => workspace.readFile(path, Object.freeze({signal})), {signal, timeoutMs}, {validate: value => parseWorkspaceRead(value, path), trusted: true});
      },
      captureBinaryFile: (path, signal) => {
        permit(state, 'workspace.read');
        if (!binaryArtifacts || typeof workspace?.captureBinaryFile !== 'function') throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Binary artifact port is unavailable');
        return run(state, signal => workspace.captureBinaryFile(path, Object.freeze({signal})), {signal, timeoutMs: LIMITS.maxTimeoutMs}, {validate: value => parseBinaryArtifactSource(value, path), trusted: true});
      },
      readBinaryChunk: (source, offset, length, signal, timeoutMs = LIMITS.defaultTimeoutMs) => {
        permit(state, 'workspace.read');
        return run(state, signal => source.readChunk(offset, length, Object.freeze({signal})), {signal, timeoutMs}, {validate: value => parseBinaryChunk(value, source.byteLength), trusted: true});
      },
      invokeBackend: async (id, input, options) => {
        permit(state, 'backend.invoke');
        if (typeof id !== 'string' || !backendMap.has(id)) throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Named backend is unavailable');
        try {return await backendMap.get(id)(input, Object.freeze({...options, pluginId, scope}));}
        catch {throw error(ErrorCode.PROVIDER_FAILED, 'Backend job failed');}
      },
    });
  }

  function historyState(pluginId) {
    assertOpen(); const state = plugins.get(pluginId);
    if (!state || !state.active || !state.ready) throw error(ErrorCode.DISPOSED, 'Plugin is not active');
    permit(state, 'workspace.read'); return state;
  }
  function recoverJob(pluginId, jobId) {
    const state = historyState(pluginId), recovered = jobRegistry.recover(pluginId, jobId, state.grants);
    if (recovered.record && !state.commands.has(recovered.record.snapshot.commandId)) throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Recorded command is unavailable');
    return recovered;
  }
  function storedReference(pluginId,jobId,artifactId){
    const recovery=recoverJob(pluginId,jobId),snapshot=recovery.record?.retainedArtifacts?.find(s=>s.artifact.id===artifactId);
    if(!snapshot)throw error(ErrorCode.CAPABILITY_UNAVAILABLE,'Stored artifact is unavailable');
    return parseStoredArtifactReference({protocolVersion:1,storage:'snapshot',scope,snapshot});
  }
  function currentStoredReference(reference){
    if(reference.scope.projectId!==scope.projectId||reference.scope.sessionId!==scope.sessionId)throw error(ErrorCode.CONFLICT,'Stored artifact belongs to another host generation');
    const s=reference.snapshot,current=storedReference(s.pluginId,s.jobId,s.artifact.id);
    if(!storageEqual(current,reference))throw error(ErrorCode.CONFLICT,'Stored artifact identity changed');
    return historyState(s.pluginId);
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
      for (const language of languages.values()) language.invalidate();
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
    async requestLanguage(kind, input = {}, options = {}) {
      assertOpen();
      if (!document) throw error(ErrorCode.INVALID_CONTRACT, 'Set a document before requesting language features');
      if (!languages.has(kind)) throw error(ErrorCode.INVALID_CONTRACT, 'Unknown language feature');
      const value = parseJsonValue(input);
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !['position', 'includeDeclaration', 'context', 'newName'].includes(key))) throw error(ErrorCode.INVALID_CONTRACT, 'Expected language request input');
      const request = parseLanguageRequest({protocolVersion: 1, requestId: `request-${++nextRequest}`, scope, snapshot: document, kind, ...value});
      const currentRevision = revision;
      const result = await languages.get(kind).request(request, options);
      if (revision !== currentRevision) throw error(ErrorCode.STALE_SNAPSHOT, 'Document changed while language features were pending');
      return result;
    },
    languageCapabilities() {assertOpen(); return Object.freeze({protocolVersion: 1, features: LANGUAGE_FEATURES, completionResolve: true, snippets: true, positions: 'utf16-zero-based', limits: LANGUAGE_LIMITS});},
    async resolveCompletion(token, options = {}) {
      assertOpen(); const currentRevision = revision;
      const result = await languages.get('completion').resolve(token, options);
      if (revision !== currentRevision) throw error(ErrorCode.STALE_SNAPSHOT, 'Document changed while completion resolution was pending');
      return result;
    },
    prepareCompletion(result, itemIndex = 0) {assertOpen(); return languages.get('completion').prepareCompletion(result, itemIndex);},
    releaseCompletion(result) {assertOpen(); languages.get('completion').releaseCompletion(result);},
    listPlugins() {assertOpen(); return Object.freeze([...plugins.values()].filter(state => state.ready && state.active).map(state => state.manifest));},
    listCommands() {
      assertOpen();
      return Object.freeze([...plugins.values()].filter(state => state.ready && state.active).flatMap(state => [...state.commands.values()].map(entry => Object.freeze({pluginId: state.manifest.id, ...entry.command}))));
    },
    async executeCommand(pluginId, commandId, input, options = {}) {
      assertOpen();
      const state = plugins.get(pluginId);
      if (!state || !state.active || !state.ready) throw error(ErrorCode.DISPOSED, 'Plugin is not active');
      const entry = state.commands.get(commandId);
      if (!entry) throw error(ErrorCode.CAPABILITY_UNAVAILABLE, 'Command is unavailable');
      const value = parseCommandInput(input, entry.command);
      return run(state, signal => entry.handler(value, Object.freeze({signal})), options, {entry});
    },
    jobCapabilities() {assertOpen(); return jobRegistry.capabilities();},
    binaryArtifactCapabilities() {assertOpen(); return jobRegistry.binaryCapabilities();},
    jobStorageCapabilities() {assertOpen(); return jobRegistry.storageCapabilities();},
    artifactStorageCapabilities(){assertOpen();return jobRegistry.artifactStorageCapabilities();},
    listStoredJobArtifacts(pluginId,jobId){return jobRegistry.listStoredArtifacts(pluginId,recoverJob(pluginId,jobId));},
    async getStoredJobArtifact(pluginId,jobId,artifactId,options={}){
      const reference=storedReference(pluginId,jobId,artifactId),state=currentStoredReference(reference),checked=checkedOptions(options);
      await run(state,signal=>jobRegistry.verifyStoredArtifact(reference.snapshot,{...checked,signal}),checked,{trusted:true,validate:parseStoredArtifact});
      currentStoredReference(reference);return reference;
    },
    async readStoredJobArtifactChunk(value,offset,length,options={}){
      const reference=parseStoredArtifactReference(value),state=currentStoredReference(reference),checked=checkedOptions(options);
      parseBinaryArtifactRange(offset,length,reference.snapshot.artifact.byteLength);
      const chunk=await run(state,signal=>jobRegistry.readStoredArtifact(reference.snapshot,offset,length,{...checked,signal}),checked,{trusted:true,validate:value=>parseBinaryChunk(value,reference.snapshot.artifact.byteLength)});
      currentStoredReference(reference);
      const result=parseStoredArtifactChunk({reference,...chunk});
      if(result.offset!==offset||result.nextOffset!==offset+Math.min(length,reference.snapshot.artifact.byteLength-offset))throw error(ErrorCode.INVALID_CONTRACT,'Stored artifact range mismatch');
      const digest=[...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',decodeBinaryArtifactData(result.data)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      currentStoredReference(reference);if(checked.signal?.aborted)throw error(ErrorCode.CANCELLED,'Stored artifact read cancelled');
      if(digest!==result.sha256)throw error(ErrorCode.CONFLICT,'Stored artifact chunk checksum mismatch');
      return result;
    },
    // The owner can flush cancellation checkpoints after dispose(). The store
    // itself remains owner-managed and must be closed after this promise settles.
    flushJobStore() {return jobRegistry.flushStorage();},
    recoverJob,
    listJobHistory(pluginId, query) {
      const state = historyState(pluginId);
      return jobRegistry.history(pluginId, query, state.grants, state.commands);
    },
    async retryCommandJob(pluginId, previousJobId, input, options) {
      parseJobId(previousJobId); options = parseJobOptions(options);
      const original = recoverJob(pluginId, previousJobId);
      if (!['completed','interrupted'].includes(original.disposition)) throw error(ErrorCode.CONFLICT, 'A retained completed or interrupted job is required');
      const commandId = original.record.snapshot.commandId, state = historyState(pluginId), entry = state.commands.get(commandId);
      const value = parseCommandInput(input, entry.command);
      const replay = await jobRegistry.retryResult(pluginId, commandId, previousJobId, value, options, state.grants);
      historyState(pluginId);
      if (replay) return recoverJob(pluginId, options.jobId);
      const currentOriginal = recoverJob(pluginId, previousJobId);
      if (!['completed','interrupted'].includes(currentOriginal.disposition)) throw error(ErrorCode.CONFLICT, 'Original job is no longer retained');
      startCommandJob(pluginId, commandId, value, options, previousJobId);
      await jobRegistry.flushStorage();
      return recoverJob(pluginId, options.jobId);
    },
    startCommandJob: (pluginId, commandId, input, options) => startCommandJob(pluginId, commandId, input, options),
    getJob(jobId) {assertOpen(); return jobRegistry.get(jobId);},
    getJobEvents(jobId, after) {assertOpen(); return jobRegistry.events(jobId, after);},
    cancelJob(jobId) {assertOpen(); return jobRegistry.cancel(jobId);},
    readJobArtifact(jobId, artifactId, options = {}) {
      assertOpen(); const {signal, timeoutMs} = checkedOptions(options); return jobRegistry.readArtifact(jobId, artifactId, signal, timeoutMs);
    },
    listJobBinaryArtifacts(jobId) {assertOpen(); return jobRegistry.listBinaryArtifacts(jobId);},
    readJobBinaryArtifactChunk(jobId, artifactId, revision, offset, length, options = {}) {
      assertOpen(); const {signal, timeoutMs} = checkedOptions(options);
      return jobRegistry.readBinaryArtifact(jobId, artifactId, revision, offset, length, signal, timeoutMs);
    },
    deactivate(pluginId) {
      assertOpen();
      const state = plugins.get(pluginId);
      if (state) { cleanup(state); plugins.delete(pluginId); }
    },
    dispose() {
      if (disposed) return;
      jobRegistry.dispose();
      disposed = true;
      for (const state of plugins.values()) cleanup(state);
      plugins.clear();
      registry.dispose();
      for (const language of languages.values()) language.dispose();
      document = undefined;
    },
  });
}
