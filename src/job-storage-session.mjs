import {parseGrants, parseJsonValue, parseScope} from './contracts.mjs';
import {parseJobId, parseJobEvent, parseJobSnapshot} from './jobs.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';
import {JOB_STORE_LIMITS, parseJobStoreIdentity, parseJobStoreLimits, parseStoredJob, parseJobRecovery, parseJobStorageCapabilities} from './job-storage.mjs';
import {storageObject, storageSha} from './job-storage-validation.mjs';
import {createJobHistoryIndex} from './job-history-index.mjs';
import {createArtifactStorageSession} from './artifact-storage-session.mjs';

const failure = code => new PluginSdkError(code, 'Job persistence operation failed');
const hash = async text => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(value => value.toString(16).padStart(2, '0')).join('');
const noLabel = artifact => {const {label: _label, ...result} = artifact; return result;};

/** Coalesced, bounded asynchronous checkpoints; the existing synchronous v1 API stays live-only. */
export function createJobStorageSession(scope, options, snapshot) {
  scope = parseScope(scope);
  if (options === undefined) return Object.freeze({
    enabled: false, capabilities: () => parseJobStorageCapabilities({protocolVersion: 1, enabled: false, identity: null, limits: JOB_STORE_LIMITS}),
    has: () => false, register() {}, mark() {}, settle() {}, forget() {}, beforeExecute: async () => {}, flush: async () => {},
    recover() {throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);},
    history() {throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);},
    artifactStorage:createArtifactStorageSession(),
    captureArtifact:async()=>{},
  });
  storageObject(options, ['store', 'workspaceIdentity', 'pluginArtifacts'], ['redact','artifacts']);
  const {store, redact} = options;
  if (!store || typeof store !== 'object' || ['has', 'get', 'entries', 'pin', 'write', 'flush'].some(key => typeof store[key] !== 'function')) throw failure(ErrorCode.INVALID_CONTRACT);
  const identity = parseJobStoreIdentity(store.identity), limits = parseJobStoreLimits(store.limits);
  storageSha(options.workspaceIdentity);
  if (identity.workspaceId !== scope.projectId || identity.workspaceIdentity !== options.workspaceIdentity) throw failure(ErrorCode.CONFLICT);
  const artifactStorage=createArtifactStorageSession(identity,options.artifacts);
  if (redact !== undefined && typeof redact !== 'function') throw failure(ErrorCode.INVALID_CONTRACT);
  const artifacts = parseJsonValue(options.pluginArtifacts);
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) throw failure(ErrorCode.INVALID_CONTRACT);
  for (const value of Object.values(artifacts)) storageSha(value);
  const entries = new Map(), dirty = new Map(); let processing = false, waiters = 0;
  function authorizedRecords(pluginId, grants, commands) {
    const artifactSha256 = artifacts[pluginId]; storageSha(artifactSha256); grants = parseGrants(grants);
    const records = store.entries();
    if (!Array.isArray(records) || records.length > limits.records) throw failure(ErrorCode.BUDGET_EXCEEDED);
    return records.map(parseStoredJob).filter(record => record.storeId === identity.storeId && record.workspaceId === scope.projectId && record.workspaceIdentity === identity.workspaceIdentity && record.snapshot.pluginId === pluginId && record.pluginArtifactSha256 === artifactSha256 && record.grants.every(grant => grants.includes(grant)) && commands.has(record.snapshot.commandId));
  }
  const history = createJobHistoryIndex(scope, identity, pluginId => artifacts[pluginId], authorizedRecords, jobId => entries.has(jobId) && !entries.get(jobId).forgotten);

  function redactValue(entry, kind, value) {
    if (!redact) return null;
    return parseJsonValue(redact(Object.freeze({kind, value, jobId: entry.r.jobId, pluginId: entry.r.pluginId, commandId: entry.r.commandId})));
  }
  function progress(entry, value) {
    if (value === null) return null;
    const {message, ...result} = value;
    const reviewed = message === undefined ? null : redactValue(entry, 'progress', message);
    return reviewed === null ? result : {...result, message: reviewed};
  }
  async function capture(entry) {
    const current = snapshot(entry.r);
    const safeSnapshot = parseJobSnapshot({...current, progress: progress(entry, current.progress), artifacts: current.artifacts.map(noLabel), ...(current.state === 'succeeded' ? {result: redactValue(entry, 'result', current.result)} : {})});
    const events = entry.r.events.map(({event}) => {
      let data = event.data;
      if (event.kind === 'log') data = {level: data.level, message: redactValue(entry, 'log', data.message) ?? '[redacted]'};
      if (event.kind === 'progress') data = progress(entry, data);
      if (event.kind === 'artifact') data = noLabel(data);
      return parseJobEvent({...event, data});
    });
    // Capture all mutable state before the first await. An in-flight write can
    // therefore never claim a later event/settlement was included in its digest.
    const savedAt = Math.max(Date.now(), current.updatedAt, entry.savedAt), settled = entry.r.settled;
    const binaryArtifacts = [...entry.r.binaryArtifacts.values()].map(value => noLabel(value.artifact));
    const retainedArtifacts=[...entry.r.storedArtifacts.values()];
    const signature = entry.r.signature;
    const requestSha256 = entry.requestSha256 ?? await hash(signature);
    entry.requestSha256 = requestSha256;
    return parseStoredJob({...identity, pluginArtifactSha256: entry.artifactSha256, requestSha256, revision: entry.revision + 1, savedAt, expiresAt: savedAt + limits.retentionMs, settled, contentPolicy: redact ? 'host-redacted' : 'metadata-only', grants: entry.grants, snapshot: safeSnapshot, events, binaryArtifacts, ...(entry.r.attemptOf === undefined ? {} : {attemptOf: entry.r.attemptOf}), ...(retainedArtifacts.length?{retainedArtifacts}:{})});
  }
  function completeWaiters(entry) {
    if (entry.r.settled && (entry.failed || entry.committedVersion >= entry.version)) entry.release();
    const remaining = [];
    for (const waiter of entry.waiting) {
      if (entry.failed || waiter.version <= entry.committedVersion) {waiters--; if (entry.failed) waiter.reject(entry.failed); else waiter.resolve();}
      else remaining.push(waiter);
    }
    entry.waiting = remaining;
  }
  function discard(entry) {
    if (entry.forgotten && !dirty.has(entry.r.jobId) && !entry.writing && !entry.waiting.length) entries.delete(entry.r.jobId);
  }
  async function pump() {
    if (processing) return; processing = true;
    try {
      while (dirty.size) {
        const [jobId, entry] = dirty.entries().next().value; dirty.delete(jobId);
        if (entry.failed) {completeWaiters(entry); discard(entry); continue;}
        const version = entry.version; entry.writing = true;
        try {
          const candidate = await capture(entry), committed = parseStoredJob(await store.write(candidate, entry.revision));
          if (JSON.stringify(committed) !== JSON.stringify(candidate)) throw failure(ErrorCode.INVALID_CONTRACT);
          entry.revision = committed.revision; entry.savedAt = committed.savedAt; entry.committedVersion = version;
        } catch (error) {
          entry.failed = failure(error instanceof PluginSdkError ? error.code : ErrorCode.PROVIDER_FAILED);
          dirty.delete(jobId); entry.r.controller.abort(entry.failed);
        } finally {entry.writing = false; completeWaiters(entry); discard(entry);}
      }
    } finally {processing = false;}
  }
  function waitFor(entry) {
    if (entry.failed) return Promise.reject(entry.failed);
    if (entry.committedVersion >= entry.version) return Promise.resolve();
    if (waiters >= limits.pendingWrites) return Promise.reject(failure(ErrorCode.BUDGET_EXCEEDED));
    waiters++;
    return new Promise((resolve, reject) => {entry.waiting.push({version: entry.version, resolve, reject}); void pump();});
  }
  return Object.freeze({
    enabled: true,
    capabilities: () => parseJobStorageCapabilities({protocolVersion: 1, enabled: true, identity, limits}),
    history,
    artifactStorage,
    async captureArtifact(r,kind,artifact,source,signal){
      if(!artifactStorage.enabled)return;
      const entry=entries.get(r.jobId),stored=await artifactStorage.capture(r,kind,artifact,source,entry.artifactSha256,signal);
      return stored;
    },
    listStoredArtifacts(pluginId,recovery){return artifactStorage.list(pluginId,artifacts[pluginId],recovery);},
    has(jobId) {return store.has(parseJobId(jobId));},
    register(r, grants) {
      const artifactSha256 = artifacts[r.pluginId]; storageSha(artifactSha256);
      const release = store.pin(r.jobId);
      if (typeof release !== 'function') throw failure(ErrorCode.INVALID_CONTRACT);
      entries.set(r.jobId, {r, artifactSha256, grants: parseGrants(grants), release, version: 0, committedVersion: 0, revision: 0, savedAt: 0, waiting: [], failed: null});
    },
    mark(r) {
      const entry = entries.get(r.jobId); if (!entry || entry.failed) return;
      entry.version++; dirty.set(r.jobId, entry); queueMicrotask(() => {void pump();});
    },
    settle(r) {const entry = entries.get(r.jobId); if (entry) completeWaiters(entry);},
    forget(r) {const entry = entries.get(r.jobId); if (entry) {entry.forgotten = true; discard(entry);}},
    beforeExecute(r) {return waitFor(entries.get(r.jobId));},
    async flush() {
      const results = await Promise.allSettled([...entries.values()].map(waitFor));
      await store.flush();
      const rejected = results.find(result => result.status === 'rejected'); if (rejected) throw rejected.reason;
    },
    recover(pluginId, jobId, grants, live) {
      parseJobId(jobId); const artifactSha256 = artifacts[pluginId]; storageSha(artifactSha256); grants = parseGrants(grants);
      const response = (disposition, record = null) => parseJobRecovery({protocolVersion: 1, jobId, scope, storeId: identity.storeId, disposition, unrecordedTail: disposition === 'completed' ? 'none' : 'unknown', record});
      let record;
      try {record = store.get(jobId);} catch (error) {
        if (error?.code === ErrorCode.CONFLICT) return response('corrupt');
        if (error?.code === ErrorCode.VERSION_MISMATCH) return response('unsupported');
        throw error;
      }
      if (record === null) return response('missing');
      record = parseStoredJob(record);
      if (record.storeId !== identity.storeId || record.workspaceId !== scope.projectId || record.workspaceIdentity !== identity.workspaceIdentity || record.snapshot.pluginId !== pluginId || record.pluginArtifactSha256 !== artifactSha256) throw failure(ErrorCode.CONFLICT);
      if (!record.grants.every(grant => grants.includes(grant))) throw failure(ErrorCode.PERMISSION_DENIED);
      if (record.expiresAt <= Date.now()) return response('expired');
      return response(record.settled ? 'completed' : live ? 'live' : 'interrupted', record);
    },
  });
}
