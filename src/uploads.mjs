import {copyWorkspaceJson,exactObject,requireText,requireUuid,requireSha256,requireWorkspacePath,workspaceFailure} from './workspace-values.mjs';
import {decodeBinaryArtifactData} from './artifacts.mjs';
import {parseScope} from './contracts.mjs';
export {uploadFile} from './upload-transfer.mjs';

export const UPLOAD_LIMITS=Object.freeze({fileBytes:1_073_741_824,chunkBytes:65_536,storeBytes:4_294_967_296,records:64,active:4,pending:16,retentionMs:86_400_000,recordBytes:16_384,roots:16,timeoutMs:30_000});
export const DEFAULT_UPLOAD_LIMITS=Object.freeze({...UPLOAD_LIMITS,fileBytes:134_217_728,storeBytes:268_435_456,retentionMs:3_600_000});
export const UPLOAD_STATES=Object.freeze(['receiving','committing','committed','aborted','expired','corrupt','uncertain']);
export const EMPTY_UPLOAD_SHA256='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const invalid=()=>{throw workspaceFailure('invalid_request','Invalid upload contract');};
export function uploadInteger(value,max=Number.MAX_SAFE_INTEGER,min=0){if(!Number.isSafeInteger(value)||value<min||value>max)invalid();return value;}
export function uploadUuid(value){requireUuid(value);if(value!==value.toLowerCase())invalid();return value;}
export function parseUploadLimits(value){const v=copyWorkspaceJson(value);exactObject(v,Object.keys(UPLOAD_LIMITS));for(const [key,max]of Object.entries(UPLOAD_LIMITS))uploadInteger(v[key],max,1);if(v.fileBytes>v.storeBytes||v.active>v.records)invalid();return v;}
export function parseUploadIdentity(value){const v=copyWorkspaceJson(value);exactObject(v,['protocolVersion','storeId','workspaceId','workspaceIdentity','principalId']);if(v.protocolVersion!==1)invalid();uploadUuid(v.storeId);requireUuid(v.workspaceId);requireSha256(v.workspaceIdentity);requireText(v.principalId);return v;}
export function parseUploadSpec(value){
  const v=copyWorkspaceJson(value);exactObject(v,['uploadId','pluginId','artifactSha256','path','byteLength','sha256','expectedRevision']);
  uploadUuid(v.uploadId);requireText(v.pluginId);requireSha256(v.artifactSha256);requireWorkspacePath(v.path);uploadInteger(v.byteLength,UPLOAD_LIMITS.fileBytes);requireSha256(v.sha256);if(v.expectedRevision!==null)requireSha256(v.expectedRevision);if(v.byteLength===0&&v.sha256!==EMPTY_UPLOAD_SHA256)invalid();return v;
}
export function parseUploadQuery(value){const v=copyWorkspaceJson(value);exactObject(v,['uploadId','pluginId','artifactSha256'],['recover']);uploadUuid(v.uploadId);requireText(v.pluginId);requireSha256(v.artifactSha256);if(v.recover!==undefined&&typeof v.recover!=='boolean')invalid();return v;}
export function parseUploadReference(value){
  const v=copyWorkspaceJson(value);exactObject(v,['protocolVersion','scope','identity','uploadGeneration','spec','createdAt','expiresAt']);if(v.protocolVersion!==1)invalid();parseScope(v.scope);requireUuid(v.scope.sessionId);const identity=parseUploadIdentity(v.identity);if(v.scope.projectId!==identity.workspaceId)invalid();uploadUuid(v.uploadGeneration);parseUploadSpec(v.spec);uploadInteger(v.createdAt);uploadInteger(v.expiresAt,v.createdAt+UPLOAD_LIMITS.retentionMs,v.createdAt+1);return v;
}
export function parseUploadCommitReceipt(value){const v=copyWorkspaceJson(value);exactObject(v,['uploadId','uploadGeneration','path','revision','byteLength','committedAt','verified']);uploadUuid(v.uploadId);uploadUuid(v.uploadGeneration);requireWorkspacePath(v.path);requireSha256(v.revision);uploadInteger(v.byteLength,UPLOAD_LIMITS.fileBytes);uploadInteger(v.committedAt);if(v.verified!==true)invalid();return v;}
export function parseUploadStatus(value){
  const v=copyWorkspaceJson(value);exactObject(v,['reference','state','offset','prefixSha256','updatedAt','commitReceipt']);const r=parseUploadReference(v.reference),s=r.spec;
  if(!UPLOAD_STATES.includes(v.state))invalid();uploadInteger(v.offset,s.byteLength);requireSha256(v.prefixSha256);uploadInteger(v.updatedAt,Number.MAX_SAFE_INTEGER,r.createdAt);
  if(v.offset===0&&v.prefixSha256!==EMPTY_UPLOAD_SHA256)invalid();
  if(['committing','committed','uncertain'].includes(v.state)&&(v.offset!==s.byteLength||v.prefixSha256!==s.sha256))invalid();
  if(v.state==='committed'){
    const c=parseUploadCommitReceipt(v.commitReceipt);
    if(c.uploadId!==s.uploadId||c.uploadGeneration!==r.uploadGeneration||c.path!==s.path||c.revision!==s.sha256||c.byteLength!==s.byteLength||c.committedAt<r.createdAt||c.committedAt>v.updatedAt)invalid();
  }else if(v.commitReceipt!==null)invalid();return v;
}
export function parseUploadChunk(value,byteLength=UPLOAD_LIMITS.fileBytes){
  const v=copyWorkspaceJson(value);exactObject(v,['offset','data','sha256']);uploadInteger(v.offset,byteLength);requireSha256(v.sha256);const bytes=decodeBinaryArtifactData(v.data);if(!bytes.length||v.offset+bytes.length>byteLength)invalid();return v;
}
export function parseUploadCapabilities(value){
  const v=copyWorkspaceJson(value);exactObject(v,['protocolVersion','enabled','scope','identity','roots','limits','profile']);if(v.protocolVersion!==1||typeof v.enabled!=='boolean'||v.profile!=='local-node-v1')invalid();parseScope(v.scope);parseUploadLimits(v.limits);
  if(!Array.isArray(v.roots)||v.roots.length>UPLOAD_LIMITS.roots||new Set(v.roots).size!==v.roots.length)invalid();for(const root of v.roots)requireWorkspacePath(root,true);
  if(v.enabled){const identity=parseUploadIdentity(v.identity);if(!v.roots.length||identity.workspaceId!==v.scope.projectId)invalid();}else if(v.identity!==null||v.roots.length)invalid();return v;
}
export function parseUploadRequest(method,value){
  const v=copyWorkspaceJson(value);
  if(method==='uploads.capabilities'){exactObject(v,[]);return v;}
  if(method==='uploads.begin'){exactObject(v,['spec']);parseUploadSpec(v.spec);return v;}
  if(method==='uploads.query'){exactObject(v,['query']);parseUploadQuery(v.query);return v;}
  if(!['uploads.write','uploads.commit','uploads.abort'].includes(method))invalid();exactObject(v,['reference',...(method==='uploads.write'?['chunk']:[])]);const reference=parseUploadReference(v.reference);if(method==='uploads.write')parseUploadChunk(v.chunk,reference.spec.byteLength);return v;
}
export function parseUploadResult(method,value){return method==='uploads.capabilities'?parseUploadCapabilities(value):parseUploadStatus(value);}
