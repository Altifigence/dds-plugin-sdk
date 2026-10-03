import {parseJsonValue, parseScope, parseWorkspacePath, parseFileContent} from './contracts.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';
import {isSafeWorkspaceRelativePath} from './patterns.mjs';

export const JOB_PROTOCOL_VERSION = 1;
export const JOB_LIMITS = Object.freeze({concurrent: 4, retained: 32, operations: 32, events: 256, eventBytes: 65_536, messageBytes: 2_048, artifacts: 16, defaultTimeoutMs: 300_000, maxTimeoutMs: 1_800_000, retentionMs: 900_000, pageSize: 64});
export const JOB_STATES = Object.freeze(['running', 'succeeded', 'failed', 'cancelled', 'timed_out']);
const fail = () => {throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, 'Invalid job contract');};
const text = (v, max = 128) => {if (typeof v !== 'string' || !v || v.length > max || !v.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(v)) fail(); return v;};
const integer = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => {if (!Number.isSafeInteger(v) || v < min || v > max) fail(); return v;};
const exact = (v, required, optional = []) => {if (!v || typeof v !== 'object' || Array.isArray(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail();};
const sha = v => {if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail(); return v;};
export function parseJobId(v) {if (typeof v !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)) fail(); return v;}
export function parseJobOptions(value) {
  const v = parseJsonValue(value); exact(v, ['jobId'], ['timeoutMs']); parseJobId(v.jobId);
  if (v.timeoutMs !== undefined) integer(v.timeoutMs, 1, JOB_LIMITS.maxTimeoutMs);
  return Object.freeze({jobId: v.jobId, timeoutMs: v.timeoutMs ?? JOB_LIMITS.defaultTimeoutMs});
}
export function parseJobProgress(value) {
  const v = parseJsonValue(value); exact(v, ['completed', 'total'], ['message']);
  integer(v.total, 1); integer(v.completed, 0, v.total); if (v.message !== undefined) text(v.message, JOB_LIMITS.messageBytes);
  if (new TextEncoder().encode(v.message ?? '').length > JOB_LIMITS.messageBytes) fail();
  return v;
}
export function parseJobArtifact(value) {
  const v = parseJsonValue(value); exact(v, ['id', 'path', 'revision', 'byteLength'], ['label']);
  text(v.id); parseWorkspacePath(v.path); if (!isSafeWorkspaceRelativePath(v.path)) fail(); sha(v.revision); integer(v.byteLength, 0, 262_144); if (v.label !== undefined) text(v.label, 256);
  return v;
}
export function parseJobEvent(value) {
  const v = parseJsonValue(value); exact(v, ['sequence', 'at', 'kind', 'data']); integer(v.sequence, 1); integer(v.at);
  if (v.kind === 'progress') parseJobProgress(v.data);
  else if (v.kind === 'artifact') parseJobArtifact(v.data);
  else if (v.kind === 'state') {exact(v.data, ['state']); if (!JOB_STATES.includes(v.data.state)) fail();}
  else if (v.kind === 'log') {
    exact(v.data, ['level', 'message']); if (!['debug', 'info', 'warning', 'error'].includes(v.data.level)) fail();
    text(v.data.message, JOB_LIMITS.messageBytes); if (new TextEncoder().encode(v.data.message).length > JOB_LIMITS.messageBytes) fail();
  } else fail();
  return v;
}
export function parseJobSnapshot(value) {
  const v = parseJsonValue(value); exact(v, ['protocolVersion', 'jobId', 'scope', 'pluginId', 'commandId', 'state', 'startedAt', 'updatedAt', 'timeoutMs', 'progress', 'artifacts', 'lastSequence'], ['result', 'error']);
  if (v.protocolVersion !== 1 || !JOB_STATES.includes(v.state)) fail(); parseJobId(v.jobId); parseScope(v.scope); text(v.pluginId); text(v.commandId);
  integer(v.startedAt); integer(v.updatedAt, v.startedAt); integer(v.timeoutMs, 1, JOB_LIMITS.maxTimeoutMs); integer(v.lastSequence, 1);
  if (v.progress !== null) parseJobProgress(v.progress);
  if (!Array.isArray(v.artifacts) || v.artifacts.length > JOB_LIMITS.artifacts || new Set(v.artifacts.map(a => a.id)).size !== v.artifacts.length) fail();
  for (const a of v.artifacts) parseJobArtifact(a);
  if (v.state === 'succeeded') {if (!Object.hasOwn(v, 'result') || v.error !== undefined) fail();}
  else if (v.result !== undefined) fail();
  if (['failed', 'cancelled', 'timed_out'].includes(v.state)) {
    exact(v.error, ['code']); if (!Object.values(ErrorCode).includes(v.error.code)) fail();
  } else if (v.error !== undefined) fail();
  return v;
}
export function parseJobEvents(value) {
  const v = parseJsonValue(value); exact(v, ['jobId', 'scope', 'after', 'nextCursor', 'dropped', 'hasMore', 'events']);
  parseJobId(v.jobId); parseScope(v.scope); integer(v.after); integer(v.nextCursor, v.after); integer(v.dropped); if (typeof v.hasMore !== 'boolean' || !Array.isArray(v.events) || v.events.length > JOB_LIMITS.pageSize) fail();
  let sequence = v.after + v.dropped;
  for (const event of v.events) {parseJobEvent(event); if (event.sequence !== ++sequence) fail();}
  if (v.nextCursor !== sequence || v.hasMore && v.events.length !== JOB_LIMITS.pageSize) fail();
  return v;
}
export function parseJobCapabilities(value) {
  const v = parseJsonValue(value); exact(v, ['protocolVersion', 'enabled', 'limits']); if (v.protocolVersion !== 1 || typeof v.enabled !== 'boolean') fail();
  exact(v.limits, Object.keys(JOB_LIMITS)); for (const [k, max] of Object.entries(JOB_LIMITS)) integer(v.limits[k], 1, max);
  return v;
}
export function parseJobArtifactContent(value) {
  // Content has its own 256 KiB budget; keep envelope overhead outside it.
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 4 || keys.some(key => !['jobId', 'scope', 'artifact', 'content'].includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, key)))) fail();
  const meta = parseJsonValue({jobId: value.jobId, scope: value.scope, artifact: value.artifact});
  const v = Object.freeze({...meta, content: parseFileContent(value.content)});
  parseJobId(v.jobId); parseScope(v.scope); parseJobArtifact(v.artifact); parseFileContent(v.content);
  if (new TextEncoder().encode(v.content).length !== v.artifact.byteLength) fail();
  return v;
}
