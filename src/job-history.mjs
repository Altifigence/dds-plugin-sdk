import {parseJsonValue, parseScope} from './contracts.mjs';
import {JOB_STATES, parseJobId} from './jobs.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';
import {storageObject, storageInteger, storageSha} from './job-storage-validation.mjs';

export const JOB_HISTORY_LIMITS = Object.freeze({pageSize: 32, snapshots: 8, cursorMs: 60_000, records: 256});
const fail = () => {throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, 'Invalid job history contract');};
const dispositions = ['live', 'completed', 'interrupted', 'expired'];
const text = value => {if (typeof value !== 'string' || !value || value.length > 128 || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value;};
function cursor(value) {
  if (typeof value !== 'string' || value.length > 41 || !/^[a-f0-9-]{36}:(?:0|[1-9][0-9]{0,2})$/.test(value)) fail();
  const [id, offset] = value.split(':'); parseJobId(id); storageInteger(Number(offset), 0, JOB_HISTORY_LIMITS.records); return value;
}
export function parseJobHistoryQuery(value = {}) {
  const v = parseJsonValue(value); storageObject(v, [], ['limit', 'state', 'disposition', 'commandId', 'from', 'to', 'attemptOf', 'cursor']);
  const limit = storageInteger(v.limit ?? 16, 1, JOB_HISTORY_LIMITS.pageSize);
  if (v.state !== undefined && !JOB_STATES.includes(v.state)) fail();
  if (v.disposition !== undefined && !dispositions.includes(v.disposition)) fail();
  if (v.commandId !== undefined) text(v.commandId);
  if (v.from !== undefined) storageInteger(v.from);
  if (v.to !== undefined) storageInteger(v.to);
  if (v.from !== undefined && v.to !== undefined && v.from > v.to) fail();
  if (v.attemptOf !== undefined) parseJobId(v.attemptOf);
  if (v.cursor !== undefined) cursor(v.cursor);
  return Object.freeze({...v, limit});
}
export function parseJobHistoryItem(value) {
  const v = parseJsonValue(value);
  storageObject(v, ['jobId','commandId','state','disposition','startedAt','updatedAt','expiresAt','revision','attemptOf','contentPolicy','artifactCount','resultAvailability']);
  parseJobId(v.jobId); text(v.commandId);
  if (!JOB_STATES.includes(v.state) || !dispositions.includes(v.disposition)) fail();
  storageInteger(v.startedAt); storageInteger(v.updatedAt, v.startedAt); storageInteger(v.expiresAt, v.updatedAt + 1); storageInteger(v.revision, 1);
  if (v.attemptOf !== null) {parseJobId(v.attemptOf); if (v.attemptOf === v.jobId) fail();}
  if (!['metadata-only', 'host-redacted'].includes(v.contentPolicy)) fail();
  storageInteger(v.artifactCount, 0, 16);
  if (!['none', 'source-references', 'expired'].includes(v.resultAvailability)) fail();
  if (v.disposition === 'completed' && v.state === 'running') fail();
  if (v.resultAvailability !== (v.disposition === 'expired' ? 'expired' : v.artifactCount ? 'source-references' : 'none')) fail();
  return v;
}
export function parseJobHistoryPage(value) {
  const v = parseJsonValue(value); storageObject(v, ['protocolVersion','scope','storeId','pluginId','pluginArtifactSha256','asOf','expiresAt','items','nextCursor']);
  if (v.protocolVersion !== 1) fail(); parseScope(v.scope); parseJobId(v.storeId); text(v.pluginId); storageSha(v.pluginArtifactSha256);
  storageInteger(v.asOf); storageInteger(v.expiresAt, v.asOf + 1, v.asOf + JOB_HISTORY_LIMITS.cursorMs);
  if (!Array.isArray(v.items) || v.items.length > JOB_HISTORY_LIMITS.pageSize) fail();
  const ids = new Set(); let previous;
  for (const item of v.items) {
    parseJobHistoryItem(item); if (ids.has(item.jobId)) fail(); ids.add(item.jobId);
    if (previous && (item.startedAt > previous.startedAt || item.startedAt === previous.startedAt && item.jobId <= previous.jobId)) fail();
    previous = item;
  }
  if (v.nextCursor !== null) cursor(v.nextCursor);
  return v;
}
