import {storageEqual} from './job-storage-validation.mjs';
import {parseJsonValue, parseScope} from './contracts.mjs';
import {parseJobId, JOB_LIMITS} from './jobs.mjs';
import {parseBinaryArtifact, parseBinaryChunk, BINARY_ARTIFACT_LIMITS} from './artifacts.mjs';
import {parseJobStoreIdentity} from './job-storage.mjs';
import {storageObject, storageInteger, storageSha} from './job-storage-validation.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';

export const ARTIFACT_STORE_LIMITS = Object.freeze({files:256,fileBytes:BINARY_ARTIFACT_LIMITS.fileBytes,storeBytes:4_294_967_296,chunkBytes:BINARY_ARTIFACT_LIMITS.chunkBytes,concurrent:4,retentionMs:604_800_000});
export const DEFAULT_ARTIFACT_STORE_BYTES = 268_435_456;
const fail = () => {throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, 'Invalid stored artifact contract');};
const text = value => {if(typeof value!=='string'||!value||value.length>128||!value.isWellFormed()||/[\u0000-\u001f\u007f]/u.test(value))fail();return value;};
export function parseArtifactStoreLimits(value) {
  const v=parseJsonValue(value);storageObject(v,Object.keys(ARTIFACT_STORE_LIMITS));
  for(const [key,maximum]of Object.entries(ARTIFACT_STORE_LIMITS))storageInteger(v[key],1,maximum);
  return v;
}
export function parseStoredArtifact(value) {
  const v=parseJsonValue(value);
  storageObject(v,['schemaVersion','storeId','workspaceId','workspaceIdentity','snapshotId','jobId','pluginId','pluginArtifactSha256','kind','artifact','capturedAt','expiresAt']);
  parseJobStoreIdentity({schemaVersion:v.schemaVersion,storeId:v.storeId,workspaceId:v.workspaceId,workspaceIdentity:v.workspaceIdentity});
  parseJobId(v.snapshotId);parseJobId(v.jobId);text(v.pluginId);storageSha(v.pluginArtifactSha256);
  if(!['text','binary'].includes(v.kind))fail();
  parseBinaryArtifact(v.artifact);if(v.artifact.label!==undefined||v.kind==='text'&&v.artifact.byteLength>262_144)fail();
  storageInteger(v.capturedAt);storageInteger(v.expiresAt,v.capturedAt+1,v.capturedAt+ARTIFACT_STORE_LIMITS.retentionMs);
  return v;
}
export function parseStoredArtifactReference(value) {
  const v=parseJsonValue(value);storageObject(v,['protocolVersion','storage','scope','snapshot']);
  if(v.protocolVersion!==1||v.storage!=='snapshot')fail();parseScope(v.scope);parseStoredArtifact(v.snapshot);
  if(v.scope.projectId!==v.snapshot.workspaceId)fail();return v;
}
export function parseStoredArtifactChunk(value) {
  const v=parseJsonValue(value);storageObject(v,['reference','offset','nextOffset','eof','data','sha256']);
  parseStoredArtifactReference(v.reference);const {reference,...chunk}=v;parseBinaryChunk(chunk,reference.snapshot.artifact.byteLength);return v;
}
export function parseArtifactStorageCapabilities(value) {
  const v=parseJsonValue(value);storageObject(v,['protocolVersion','enabled','identity','limits']);
  if(v.protocolVersion!==1||typeof v.enabled!=='boolean')fail();
  if(v.enabled)parseJobStoreIdentity(v.identity);else if(v.identity!==null)fail();
  parseArtifactStoreLimits(v.limits);return v;
}
export function parseStoredArtifactList(value) {
  const v=parseJsonValue(value);storageObject(v,['protocolVersion','scope','storeId','jobId','pluginId','pluginArtifactSha256','disposition','artifacts']);
  if(v.protocolVersion!==1)fail();parseScope(v.scope);parseJobId(v.storeId);parseJobId(v.jobId);text(v.pluginId);storageSha(v.pluginArtifactSha256);
  if(!['live','completed','interrupted','expired','missing','corrupt','unsupported'].includes(v.disposition))fail();
  if(!Array.isArray(v.artifacts)||v.artifacts.length>JOB_LIMITS.artifacts)fail();
  if(!['live','completed','interrupted'].includes(v.disposition)&&v.artifacts.length)fail();
  const ids=new Set();
  for(const entry of v.artifacts){
    storageObject(entry,['kind','artifact','storage','availability','snapshot']);
    if(!['text','binary'].includes(entry.kind))fail();parseBinaryArtifact(entry.artifact);
    if(entry.artifact.label!==undefined||entry.kind==='text'&&entry.artifact.byteLength>262_144||ids.has(entry.artifact.id))fail();ids.add(entry.artifact.id);
    if(entry.storage==='source'){if(entry.availability!=='source-reference'||entry.snapshot!==null)fail();}
    else if(entry.storage==='snapshot'){
      if(!['retained','expired','missing','corrupt','unsupported'].includes(entry.availability))fail();
      const s=parseStoredArtifact(entry.snapshot);
      if(s.storeId!==v.storeId||s.workspaceId!==v.scope.projectId||s.jobId!==v.jobId||s.pluginId!==v.pluginId||s.pluginArtifactSha256!==v.pluginArtifactSha256||s.kind!==entry.kind||!storageEqual(s.artifact,entry.artifact))fail();
    }else fail();
  }
  return v;
}
