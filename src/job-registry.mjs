import {parseJsonValue, parseScope, parseWorkspacePath, parseWorkspaceRead} from './contracts.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';
import {JOB_LIMITS, parseJobId, parseJobOptions, parseJobProgress, parseJobArtifact, parseJobEvent, parseJobSnapshot, parseJobEvents} from './jobs.mjs';
import {BINARY_ARTIFACT_LIMITS, parseBinaryArtifact, parseBinaryArtifactSource, parseBinaryArtifactList, parseBinaryArtifactRange, parseBinaryArtifactChunk, decodeBinaryArtifactData} from './artifacts.mjs';
import {createJobStorageSession} from './job-storage-session.mjs';
import {hostRuntime} from './host-runtime.mjs';

const failure = code => new PluginSdkError(code, 'Job operation failed');
const canonical = value => JSON.stringify(value, function (_key, v) {return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v;});
const hash = async text => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('');
const hashBytes = async bytes => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
function textSource(file){
  const bytes=new TextEncoder().encode(file.content);
  return{path:file.path,revision:file.revision,byteLength:bytes.length,async readChunk(offset,length,{signal}={}){
    parseBinaryArtifactRange(offset,length,bytes.length);if(signal?.aborted)throw failure(ErrorCode.CANCELLED);
    const chunk=bytes.subarray(offset,offset+length);let raw='';for(const byte of chunk)raw+=String.fromCharCode(byte);
    return{offset,nextOffset:offset+chunk.length,eof:offset+chunk.length===bytes.length,data:btoa(raw),sha256:await hashBytes(chunk)};
  }};
}

/** Host-owned bounded jobs. Cancellation is cooperative; unsettled work keeps its slot. */
export function createJobRegistry({scope, enabled = false, binaryArtifacts = false, jobStorage,runtime:runtimeInput}) {
  const runtime=hostRuntime(runtimeInput);
  scope = parseScope(scope); if (typeof enabled !== 'boolean' || typeof binaryArtifacts !== 'boolean') throw failure(ErrorCode.INVALID_CONTRACT);
  const records = new Map(); let closed = false, active = 0, binaryOperations = 0;
  if (jobStorage !== undefined && !enabled) throw failure(ErrorCode.INVALID_CONTRACT);
  const storage = createJobStorageSession(scope, jobStorage, snapshot,runtime);
  const assertOpen = () => {if (closed) throw failure(ErrorCode.DISPOSED); if (!enabled) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);};
  const collect = () => {const cutoff = runtime.now() - JOB_LIMITS.retentionMs; for (const [id, record] of records) if (record.settled && record.state !== 'running' && record.updatedAt <= cutoff) {records.delete(id); storage.forget(record);}};
  const find = id => {assertOpen(); parseJobId(id); collect(); const record = records.get(id); if (!record) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE); record.assertActive(); return record;};
  function snapshot(r) {
    return parseJobSnapshot({protocolVersion: 1, jobId: r.jobId, scope, pluginId: r.pluginId, commandId: r.commandId, state: r.state, startedAt: r.startedAt, updatedAt: r.updatedAt, timeoutMs: r.timeoutMs, progress: r.progress, artifacts: [...r.artifacts.values()], lastSequence: r.sequence, ...(r.state === 'succeeded' ? {result: r.result} : {}), ...(r.error ? {error: {code: r.error}} : {})});
  }
  function emit(r, kind, data) {
    const event = parseJobEvent({sequence: r.sequence + 1, at: Math.max(runtime.now(), r.updatedAt), kind, data});
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength;
    r.sequence++; r.updatedAt = event.at; r.events.push({event, bytes}); r.eventBytes += bytes;
    while (r.events.length > JOB_LIMITS.events || r.eventBytes > JOB_LIMITS.eventBytes) r.eventBytes -= r.events.shift().bytes;
    storage.mark(r);
  }
  function terminal(r, state, code) {
    if (r.state !== 'running') return;
    r.state = state; r.error = code; runtime.clearTimeout(r.timer); emit(r, 'state', {state});
  }
  function live(r) {
    assertOpen(); r.assertActive(); if (r.state !== 'running' || r.controller.signal.aborted) throw failure(ErrorCode.CANCELLED);
  }
  function track(r, operation) {
    let promise;
    try {live(r); if (r.operations.size >= JOB_LIMITS.operations) throw failure(ErrorCode.BUDGET_EXCEEDED); promise = Promise.resolve().then(() => {live(r); return operation();});}
    catch (error) {promise = Promise.reject(error); promise.catch(() => {}); return promise;}
    r.operations.add(promise);
    promise.then(() => r.operations.delete(promise), () => r.operations.delete(promise));
    return promise;
  }
  async function drain(r) {while (r.operations.size) await Promise.allSettled([...r.operations]);}
  async function binaryOperation(operation) {
    assertOpen(); if (!binaryArtifacts) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);
    if (binaryOperations >= BINARY_ARTIFACT_LIMITS.concurrent) throw failure(ErrorCode.BUDGET_EXCEEDED);
    binaryOperations++; try {return await operation();} finally {binaryOperations--;}
  }
  function reserveArtifact(r, id) {
    if (r.artifacts.has(id) || r.binaryArtifacts.has(id) || r.pendingArtifacts.has(id)) throw failure(ErrorCode.CONFLICT);
    if (r.artifacts.size + r.binaryArtifacts.size + r.pendingArtifacts.size >= JOB_LIMITS.artifacts) throw failure(ErrorCode.BUDGET_EXCEEDED);
    r.pendingArtifacts.add(id);
  }
  return Object.freeze({
    inspect(){if(!closed)collect();return Object.freeze({disposed:closed,pending:active,retained:records.size,binaryOperations,pendingCheckpoints:storage.inspect().pending});},
    capabilities() {if (closed) throw failure(ErrorCode.DISPOSED); return Object.freeze({protocolVersion: 1, enabled, limits: JOB_LIMITS});},
    binaryCapabilities() {if (closed) throw failure(ErrorCode.DISPOSED); return Object.freeze({protocolVersion: 1, enabled: enabled && binaryArtifacts, limits: BINARY_ARTIFACT_LIMITS});},
    storageCapabilities() {if (closed) throw failure(ErrorCode.DISPOSED); return storage.capabilities();},
    artifactStorageCapabilities(){if(closed)throw failure(ErrorCode.DISPOSED);return storage.artifactStorage.capabilities();},
    listStoredArtifacts(pluginId,recovery){assertOpen();return storage.listStoredArtifacts(pluginId,recovery);},
    verifyStoredArtifact(snapshot,options){assertOpen();return storage.artifactStorage.verify(snapshot,options);},
    readStoredArtifact(snapshot,offset,length,options){assertOpen();return storage.artifactStorage.readChunk(snapshot,offset,length,options);},
    flushStorage() {return storage.flush();},
    recover(pluginId, jobId, grants) {assertOpen(); return storage.recover(pluginId, jobId, grants, records.has(jobId));},
    history(pluginId, query, grants, commands) {assertOpen(); return storage.history(pluginId, query, grants, commands);},
    async retryResult(pluginId, commandId, attemptOf, input, options, grants) {
      assertOpen(); parseJobId(attemptOf); options = parseJobOptions(options);
      if (attemptOf === options.jobId) throw failure(ErrorCode.CONFLICT);
      if (!storage.has(options.jobId)) return null;
      const signature = canonical({pluginId,commandId,input,timeoutMs:options.timeoutMs,attemptOf});
      const requestSha256 = await hash(signature);
      assertOpen(); const result = storage.recover(pluginId, options.jobId, grants, records.has(options.jobId));
      if (!result.record || result.record.requestSha256 !== requestSha256 || result.record.attemptOf !== attemptOf || result.record.snapshot.commandId !== commandId) throw failure(ErrorCode.CONFLICT);
      return result;
    },
    start({pluginId, commandId, input, options, attemptOf, grants = [], signal, assertActive, assertRead, execute, validateOutput = parseJsonValue, readFile, captureBinaryFile, readBinaryChunk, invokeBackend, registerController}) {
      assertOpen(); assertActive(); options = parseJobOptions(options); input = parseJsonValue(input); collect();
      if (attemptOf !== undefined) {parseJobId(attemptOf); if (!storage.enabled || attemptOf === options.jobId) throw failure(ErrorCode.CONFLICT);}
      const signature = canonical({pluginId, commandId, input, timeoutMs: options.timeoutMs, ...(attemptOf === undefined ? {} : {attemptOf})});
      const old = records.get(options.jobId);
      if (old) {if (old.signature !== signature) throw failure(ErrorCode.CONFLICT); old.assertActive(); return snapshot(old);}
      // A prior generation's ID is history, never an instruction to re-execute.
      if (storage.has(options.jobId)) throw failure(ErrorCode.CONFLICT);
      if (active >= JOB_LIMITS.concurrent || records.size >= JOB_LIMITS.retained) throw failure(ErrorCode.BUDGET_EXCEEDED);
      if (signal.aborted) throw failure(ErrorCode.DISPOSED);
      const now = runtime.now(), controller = new AbortController();
      const r = {...options, attemptOf, pluginId, commandId, signature, assertActive, assertRead, readFile, readBinaryChunk, controller, state: 'running', startedAt: now, updatedAt: now, progress: null, artifacts: new Map(), binaryArtifacts: new Map(), storedArtifacts: new Map(), pendingArtifacts: new Set(), operations: new Set(), events: [], eventBytes: 0, sequence: 0, settled: false};
      storage.register(r, grants);
      records.set(r.jobId, r); active++; emit(r, 'state', {state: 'running'});
      const onOwnerAbort = () => controller.abort(failure(ErrorCode.DISPOSED));
      const onAbort = () => {const code = controller.signal.reason instanceof PluginSdkError ? controller.signal.reason.code : ErrorCode.CANCELLED; terminal(r, code === ErrorCode.BUDGET_EXCEEDED ? 'timed_out' : 'cancelled', code);};
      signal.addEventListener('abort', onOwnerAbort, {once: true}); controller.signal.addEventListener('abort', onAbort, {once: true});
      const unregister = registerController(controller);
      r.timer = runtime.setTimeout(() => controller.abort(failure(ErrorCode.BUDGET_EXCEEDED)), r.timeoutMs);
      const job = Object.freeze({
        reportProgress(value) {live(r); const progress = parseJobProgress(value); emit(r, 'progress', progress); r.progress = progress;},
        log(level, message) {live(r); emit(r, 'log', {level, message});},
        addArtifact(value) {return track(r, async () => {
          live(r); value = parseJsonValue(value);
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['id', 'path', 'label'].includes(k))) throw failure(ErrorCode.INVALID_CONTRACT);
          // Validate all metadata before reading, then reserve a slot across the await.
          const draft = parseJobArtifact({...value, revision: '0'.repeat(64), byteLength: 0});
          reserveArtifact(r, draft.id);
          try {
            const file = parseWorkspaceRead(await readFile(parseWorkspacePath(draft.path), controller.signal), draft.path); live(r);
            if (await hash(file.content) !== file.revision) throw failure(ErrorCode.CONFLICT); live(r);
            const artifact = parseJobArtifact({...draft, revision: file.revision, byteLength: new TextEncoder().encode(file.content).length});
            const stored=await storage.captureArtifact(r,'text',artifact,textSource(file),controller.signal);live(r);
            if(stored)r.storedArtifacts.set(artifact.id,stored);
            emit(r, 'artifact', artifact); r.artifacts.set(artifact.id, artifact); return artifact;
          } finally {r.pendingArtifacts.delete(draft.id);}
        });},
        addBinaryArtifact(value) {return track(r, () => binaryOperation(async () => {
          live(r); value = parseJsonValue(value);
          if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['id', 'path', 'label'].includes(k))) throw failure(ErrorCode.INVALID_CONTRACT);
          const draft = parseBinaryArtifact({...value, revision: '0'.repeat(64), byteLength: 0}); reserveArtifact(r, draft.id);
          try {
            const source = parseBinaryArtifactSource(await captureBinaryFile(draft.path, controller.signal), draft.path); live(r);
            const artifact = parseBinaryArtifact({...draft, revision: source.revision, byteLength: source.byteLength});
            const stored=await storage.captureArtifact(r,'binary',artifact,source,controller.signal);live(r);
            if(stored)r.storedArtifacts.set(artifact.id,stored);
            // Existing readers understand this event and the unchanged v1 snapshot.
            emit(r, 'log', {level: 'info', message: `Binary artifact registered: ${artifact.id}`});
            r.binaryArtifacts.set(artifact.id, {artifact, source}); return artifact;
          } finally {r.pendingArtifacts.delete(draft.id);}
        }));},
        invokeBackend(id, value) {return track(r, async () => {live(r); const result = await invokeBackend(id, parseJsonValue(value), {signal: controller.signal, job}); live(r); return parseJsonValue(result);});},
      });
      // Keep this slot until the actual provider settles, even after cancellation.
      Promise.resolve().then(async () => {if (storage.enabled) await storage.beforeExecute(r); live(r); return execute(input, {signal: controller.signal, job});}).then(async result => {
        await drain(r); live(r); const parsed = validateOutput(result);
        // Include metadata overhead in the snapshot budget before committing success.
        const candidate = {...r, state: 'succeeded', result: parsed}; snapshot(candidate);
        r.result = parsed; terminal(r, 'succeeded');
      }).catch(error => {
        if (r.state === 'running') terminal(r, 'failed', error instanceof PluginSdkError ? error.code : ErrorCode.PROVIDER_FAILED);
      }).finally(async () => {
        await drain(r);
        active--; r.settled = true; storage.mark(r); storage.settle(r); runtime.clearTimeout(r.timer); signal.removeEventListener('abort', onOwnerAbort); controller.signal.removeEventListener('abort', onAbort); unregister();
      });
      return snapshot(r);
    },
    get(id) {return snapshot(find(id));},
    events(id, after = 0) {
      const r = find(id); if (!Number.isSafeInteger(after) || after < 0 || after > r.sequence) throw failure(ErrorCode.INVALID_CONTRACT);
      const first = r.events[0]?.event.sequence ?? r.sequence + 1;
      const dropped = Math.max(0, first - after - 1);
      const events = r.events.filter(item => item.event.sequence > after).slice(0, JOB_LIMITS.pageSize).map(item => item.event);
      const nextCursor = events.at(-1)?.sequence ?? after + dropped;
      return parseJobEvents({jobId: id, scope, after, nextCursor, dropped, hasMore: nextCursor < r.sequence, events});
    },
    cancel(id) {const r = find(id); if (r.state === 'running') r.controller.abort(failure(ErrorCode.CANCELLED)); return snapshot(r);},
    async readArtifact(id, artifactId, signal, timeoutMs) {
      const r = find(id), artifact = r.artifacts.get(artifactId); if (!artifact) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);
      if (signal?.aborted) throw failure(ErrorCode.CANCELLED);
      const file = parseWorkspaceRead(await r.readFile(artifact.path, signal, timeoutMs), artifact.path);
      find(id); if (signal?.aborted) throw failure(ErrorCode.CANCELLED);
      if (file.revision !== artifact.revision || await hash(file.content) !== artifact.revision) throw failure(ErrorCode.CONFLICT);
      find(id); if (signal?.aborted) throw failure(ErrorCode.CANCELLED);
      return Object.freeze({jobId: id, scope, artifact, content: file.content});
    },
    listBinaryArtifacts(id) {
      if (!binaryArtifacts) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);
      const r = find(id); r.assertRead();
      return parseBinaryArtifactList({jobId: id, scope, artifacts: [...r.binaryArtifacts.values()].map(entry => entry.artifact)});
    },
    readBinaryArtifact(id, artifactId, revision, offset, length, signal, timeoutMs) {
      return binaryOperation(async () => {
        const r = find(id); r.assertRead(); const entry = r.binaryArtifacts.get(artifactId);
        if (!entry) throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);
        if (entry.artifact.revision !== revision) throw failure(ErrorCode.CONFLICT);
        parseBinaryArtifactRange(offset, length, entry.artifact.byteLength);
        if (signal?.aborted) throw failure(ErrorCode.CANCELLED);
        const chunk = await r.readBinaryChunk(entry.source, offset, length, signal, timeoutMs);
        find(id); r.assertRead(); if (signal?.aborted) throw failure(ErrorCode.CANCELLED);
        const result = parseBinaryArtifactChunk({jobId: id, scope, artifact: entry.artifact, ...chunk});
        if (result.offset !== offset || result.nextOffset !== offset + Math.min(length, entry.artifact.byteLength - offset)) throw failure(ErrorCode.INVALID_CONTRACT);
        const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', decodeBinaryArtifactData(result.data)))].map(v => v.toString(16).padStart(2, '0')).join('');
        find(id); r.assertRead(); if (signal?.aborted) throw failure(ErrorCode.CANCELLED);
        if (digest !== result.sha256) throw failure(ErrorCode.CONFLICT); return result;
      });
    },
    dispose() {if (closed) return; closed = true; for (const r of records.values()) if (r.state === 'running') r.controller.abort(failure(ErrorCode.DISPOSED)); records.clear();},
  });
}
