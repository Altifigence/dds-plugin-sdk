import {storageEqual} from './job-storage-validation.mjs';
import {DEFAULT_UPLOAD_LIMITS,parseUploadCapabilities,parseUploadSpec,parseUploadQuery,parseUploadReference,parseUploadChunk} from './uploads.mjs';
import {workspaceFailure,WorkspaceError} from './workspace-values.mjs';
const invalid=()=>{throw workspaceFailure('invalid_request','Upload reply identity or state mismatch');};
export function validateUploadReply(method,params,result,binding){
  const scope=method==='uploads.capabilities'?result.scope:result.reference.scope;
  if(scope.projectId!==binding.workspace.id||scope.sessionId!==binding.workspace.generation)invalid();
  if(method==='uploads.capabilities')return;
  const reference=result.reference,spec=reference.spec;
  if(method==='uploads.begin'&&!storageEqual(spec,params.spec))invalid();
  if(method==='uploads.query'&&['uploadId','pluginId','artifactSha256'].some(key=>spec[key]!==params.query[key]))invalid();
  if(params.reference&&!storageEqual(reference,params.reference))invalid();
  if(method==='uploads.write'&&(result.state!=='receiving'||result.offset<params.chunk.offset+atob(params.chunk.data).length))invalid();
  if(method==='uploads.commit'&&result.state!=='committed')invalid();
  if(method==='uploads.abort'&&!['aborted','committed','uncertain'].includes(result.state))invalid();
}
export function createWorkspaceUploadClient({request,getBinding,checkConnection}){
  let captured,capability;
  async function getUploadCapabilities(options){
    const binding=getBinding();checkConnection(binding,options);if(captured===binding)return capability;
    const disabled=()=>parseUploadCapabilities({protocolVersion:1,enabled:false,scope:{projectId:binding.workspace.id,sessionId:binding.workspace.generation},identity:null,roots:[],limits:DEFAULT_UPLOAD_LIMITS,profile:'local-node-v1'});
    let result;
    if(binding.hostId==='workspace-host'&&/^0\.[0-9]\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(binding.hostVersion))result=disabled();
    else try{result=await request('uploads.capabilities',{},options);}catch(error){if(!(error instanceof WorkspaceError)||error.code!=='unsupported')throw error;result=disabled();}
    checkConnection(binding,options);captured=binding;capability=result;return result;
  }
  async function permitted(spec,options,reference){
    const binding=getBinding(),cap=await getUploadCapabilities(options);checkConnection(binding,options);
    if(!cap.enabled)throw workspaceFailure('unsupported','Uploads are unavailable on this host');
    const plugin=binding.plugins.find(p=>p.manifest.id===spec.pluginId);
    if(!plugin||plugin.artifactSha256!==spec.artifactSha256)throw workspaceFailure('plugin_mismatch','Upload plugin artifact does not match this connection');
    if(!binding.capabilities.write||!plugin.manifest.permissions.includes('workspace.write'))throw workspaceFailure('permission_denied','Upload requires workspace.write');
    if(spec.path!==undefined&&!cap.roots.some(root=>root===''||spec.path.startsWith(root+'/')))throw workspaceFailure('permission_denied','Upload target is outside approved roots');
    if(spec.byteLength>cap.limits.fileBytes)throw workspaceFailure('budget_exceeded','Upload exceeds host file limit');
    if(reference&&(reference.scope.sessionId!==binding.workspace.generation||reference.scope.projectId!==binding.workspace.id))throw workspaceFailure('generation_mismatch','Recover the upload on this connection first');
    if(reference&&!storageEqual(reference.identity,cap.identity))throw workspaceFailure('conflict','Upload store identity changed');return cap;
  }
  return Object.freeze({
    getUploadCapabilities,
    async beginUpload(value,options){const spec=parseUploadSpec(value),cap=await permitted(spec,options),result=await request('uploads.begin',{spec},options);if(!storageEqual(result.reference.identity,cap.identity))invalid();return result;},
    async queryUpload(value,options){const query=parseUploadQuery(value);const cap=await permitted(query,options),result=await request('uploads.query',{query},options);if(!storageEqual(result.reference.identity,cap.identity)||!cap.roots.some(root=>root===''||result.reference.spec.path.startsWith(root+'/')))invalid();return result;},
    async writeUploadChunk(value,input,options){const reference=parseUploadReference(value),chunk=parseUploadChunk(input,reference.spec.byteLength),cap=await permitted(reference.spec,options,reference);if(atob(chunk.data).length>cap.limits.chunkBytes)throw workspaceFailure('budget_exceeded','Upload chunk exceeds host limit');return request('uploads.write',{reference,chunk},options);},
    async commitUpload(value,options){const reference=parseUploadReference(value);await permitted(reference.spec,options,reference);return request('uploads.commit',{reference},options);},
    async abortUpload(value,options){const reference=parseUploadReference(value);await permitted(reference.spec,options,reference);return request('uploads.abort',{reference},options);},
  });
}
