import {parseGrants, parseJsonValue, parseScope} from './contracts.mjs';
import {JOB_LIMITS, parseJobId, parseJobEvent, parseJobSnapshot} from './jobs.mjs';
import {parseBinaryArtifact} from './artifacts.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';
import {storageObject, storageInteger, storageSha} from './job-storage-validation.mjs';

export const JOB_STORAGE_VERSION = 1;
export const JOB_STORE_LIMITS = Object.freeze({records: 256, recordBytes: 524_288, storeBytes: 67_108_864, retentionMs: 604_800_000, pendingWrites: 32});
export const DEFAULT_JOB_RETENTION_MS = 86_400_000;
const fail = (code = ErrorCode.INVALID_CONTRACT) => {throw new PluginSdkError(code, 'Invalid job storage contract');};
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
function storageText(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}
function storageList(value, maximum, parse) {
  if (!Array.isArray(value) || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) fail();
  return Object.freeze(Array.from({length: value.length}, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
    return parse(descriptor.value);
  }));
}

export function parseJobStoreIdentity(value) {
  const v = parseJsonValue(value);
  storageObject(v, ['schemaVersion', 'storeId', 'workspaceId', 'workspaceIdentity']);
  if (v.schemaVersion !== JOB_STORAGE_VERSION) fail(ErrorCode.VERSION_MISMATCH);
  parseJobId(v.storeId); storageText(v.workspaceId); storageSha(v.workspaceIdentity);
  return v;
}

export function parseJobStoreLimits(value) {
  const v = parseJsonValue(value); storageObject(v, Object.keys(JOB_STORE_LIMITS));
  for (const [key, maximum] of Object.entries(JOB_STORE_LIMITS)) storageInteger(v[key], 1, maximum);
  if (v.recordBytes !== JOB_STORE_LIMITS.recordBytes || v.pendingWrites !== JOB_STORE_LIMITS.pendingWrites) fail();
  return v;
}

/** The snapshot remains v1. Recovery state and redaction live in a separate envelope. */
export function parseStoredJob(value) {
  storageObject(value, ['schemaVersion', 'storeId', 'workspaceId', 'workspaceIdentity', 'pluginArtifactSha256', 'requestSha256', 'revision', 'savedAt', 'expiresAt', 'settled', 'contentPolicy', 'grants', 'snapshot', 'events', 'binaryArtifacts'], ['attemptOf']);
  const {schemaVersion, storeId, workspaceId, workspaceIdentity, pluginArtifactSha256, requestSha256, revision, savedAt, expiresAt, settled, contentPolicy} = value;
  if (schemaVersion !== JOB_STORAGE_VERSION) fail(ErrorCode.VERSION_MISMATCH);
  parseJobStoreIdentity({schemaVersion, storeId, workspaceId, workspaceIdentity});
  storageSha(pluginArtifactSha256); storageSha(requestSha256); storageInteger(revision, 1);
  storageInteger(savedAt); storageInteger(expiresAt, savedAt + 1);
  if (expiresAt - savedAt > JOB_STORE_LIMITS.retentionMs || typeof settled !== 'boolean' || !['metadata-only', 'host-redacted'].includes(contentPolicy)) fail();
  const grants = parseGrants(value.grants), snapshot = parseJobSnapshot(value.snapshot);
  if (snapshot.scope.projectId !== workspaceId || savedAt < snapshot.updatedAt || settled && snapshot.state === 'running') fail();
  const events = storageList(value.events, JOB_LIMITS.events, parseJobEvent);
  if (!events.length || bytes(events) > JOB_LIMITS.eventBytes + JOB_LIMITS.events + 1) fail();
  let sequence = snapshot.lastSequence - events.length, at = snapshot.startedAt;
  if (sequence < 0) fail();
  for (const event of events) {
    if (event.sequence !== ++sequence || event.at < at || event.at > snapshot.updatedAt) fail();
    at = event.at;
  }
  if (sequence !== snapshot.lastSequence || events.at(-1).at !== snapshot.updatedAt) fail();
  const lastState = events.findLast(event => event.kind === 'state');
  if (lastState && lastState.data.state !== snapshot.state) fail();
  if (snapshot.state !== 'running' && (events.at(-1).kind !== 'state' || events.at(-1).data.state !== snapshot.state)) fail();
  const binaryArtifacts = storageList(value.binaryArtifacts, JOB_LIMITS.artifacts, parseBinaryArtifact);
  const artifactIds = [...snapshot.artifacts, ...binaryArtifacts].map(item => item.id);
  if (artifactIds.length > JOB_LIMITS.artifacts || new Set(artifactIds).size !== artifactIds.length) fail();
  if (value.attemptOf !== undefined) {parseJobId(value.attemptOf); if (value.attemptOf === snapshot.jobId) fail();}
  if (contentPolicy === 'metadata-only') {
    if (snapshot.state === 'succeeded' && snapshot.result !== null || snapshot.progress?.message !== undefined) fail();
    if ([...snapshot.artifacts, ...binaryArtifacts].some(item => item.label !== undefined)) fail();
    for (const event of events) if (event.kind === 'log' && event.data.message !== '[redacted]' || event.kind === 'progress' && event.data.message !== undefined || event.kind === 'artifact' && event.data.label !== undefined) fail();
  }
  const result = Object.freeze({schemaVersion, storeId, workspaceId, workspaceIdentity, pluginArtifactSha256, requestSha256, revision, savedAt, expiresAt, settled, contentPolicy, grants, snapshot, events, binaryArtifacts, ...(value.attemptOf === undefined ? {} : {attemptOf: value.attemptOf})});
  if (bytes(result) > JOB_STORE_LIMITS.recordBytes) fail(ErrorCode.BUDGET_EXCEEDED);
  return result;
}

export function parseJobStorageCapabilities(value) {
  const v = parseJsonValue(value); storageObject(v, ['protocolVersion', 'enabled', 'identity', 'limits']);
  if (v.protocolVersion !== 1 || typeof v.enabled !== 'boolean') fail();
  if (v.enabled) parseJobStoreIdentity(v.identity); else if (v.identity !== null) fail();
  parseJobStoreLimits(v.limits); return v;
}

export function parseJobRecovery(value) {
  storageObject(value, ['protocolVersion', 'jobId', 'scope', 'storeId', 'disposition', 'unrecordedTail', 'record']);
  const {protocolVersion, jobId, storeId, disposition} = value;
  if (protocolVersion !== 1) fail(); parseJobId(jobId); parseJobId(storeId);
  const scope = parseScope(value.scope);
  if (!['live', 'completed', 'interrupted', 'expired', 'missing', 'corrupt', 'unsupported'].includes(disposition)) fail();
  if (value.unrecordedTail !== (disposition === 'completed' ? 'none' : 'unknown')) fail();
  let record = null;
  if (['live', 'completed', 'interrupted'].includes(disposition)) {
    record = parseStoredJob(value.record);
    if (record.storeId !== storeId || record.snapshot.jobId !== jobId || record.workspaceId !== scope.projectId) fail();
    if (disposition === 'completed' && !record.settled || disposition !== 'completed' && record.settled) fail();
  } else if (value.record !== null) fail();
  return Object.freeze({protocolVersion, jobId, scope, storeId, disposition, unrecordedTail: value.unrecordedTail, record});
}
