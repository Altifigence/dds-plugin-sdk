import {BINARY_ARTIFACT_LIMITS,parseBinaryArtifact,parseBinaryArtifactReference,parseBinaryArtifactCapabilities,parseBinaryArtifactChunk,decodeBinaryArtifactData} from './artifacts.mjs';
import {parseStoredArtifactReference,parseStoredArtifactChunk,parseArtifactStorageCapabilities} from './artifact-storage.mjs';
import {storageEqual} from './job-storage-validation.mjs';
import {WORKSPACE_LIMITS,WorkspaceError,workspaceFailure,exactObject,copyWorkspaceJson,requireSha256} from './workspace-values.mjs';
import {createIncrementalSha256} from './sha256-stream.mjs';
import {PluginSdkError} from './limits.mjs';
export {createIncrementalSha256} from './sha256-stream.mjs';

export const ARTIFACT_TRANSFER_LIMITS=Object.freeze({fileBytes:BINARY_ARTIFACT_LIMITS.fileBytes,chunkBytes:BINARY_ARTIFACT_LIMITS.chunkBytes,concurrent:4,timeoutMs:1_800_000,queuedChunks:1});
const active=new Set();
const integer=(value,max=ARTIFACT_TRANSFER_LIMITS.fileBytes,min=0)=>{if(!Number.isSafeInteger(value)||value<min||value>max)throw workspaceFailure('invalid_request','Invalid transfer number');return value;};
export function parseArtifactSinkCapabilities(value){
  const v=copyWorkspaceJson(value);exactObject(v,['kind','seek','readback','persistence','abort']);
  if(!['caller','file-system-access','opfs'].includes(v.kind)||typeof v.seek!=='boolean'||typeof v.readback!=='boolean'||!['none','on-commit','per-checkpoint'].includes(v.persistence)||!['discard','retain','unknown'].includes(v.abort))throw workspaceFailure('invalid_request','Invalid sink capabilities');
  return v;
}
export function parseArtifactTransferReceipt(value){
  const v=copyWorkspaceJson(value);exactObject(v,['protocolVersion','artifact','receivedBytes','resumedBytes','receivedSha256','storedSha256','verification','committed','sink','metrics']);
  const artifact=parseBinaryArtifact(v.artifact);parseArtifactSinkCapabilities(v.sink);integer(v.receivedBytes);integer(v.resumedBytes,artifact.byteLength);requireSha256(v.receivedSha256);
  if(v.protocolVersion!==1||v.committed!==true||v.receivedBytes+v.resumedBytes!==artifact.byteLength||v.receivedSha256!==artifact.revision||v.storedSha256!==null&&v.storedSha256!==artifact.revision||v.verification!==(v.storedSha256===null?'received':'stored')||v.sink.readback!==(v.storedSha256!==null))throw workspaceFailure('invalid_request','Invalid transfer verification receipt');
  exactObject(v.metrics,['chunks','peakQueuedChunks','peakDecodedBytes','maxChunkWorkMs','elapsedMs']);integer(v.metrics.chunks,ARTIFACT_TRANSFER_LIMITS.fileBytes+1);integer(v.metrics.peakQueuedChunks,1);integer(v.metrics.peakDecodedBytes,ARTIFACT_TRANSFER_LIMITS.chunkBytes);
  for(const key of ['maxChunkWorkMs','elapsedMs'])if(typeof v.metrics[key]!=='number'||!Number.isFinite(v.metrics[key])||v.metrics[key]<0)throw workspaceFailure('invalid_request','Invalid transfer timing');
  return v;
}
export class ArtifactTransferError extends WorkspaceError {
  constructor(code,message,partial){super(code,message);this.name='ArtifactTransferError';this.partial=Object.freeze({...partial});}
}
function transferFailure(error,partial){
  let code=error?.code,message=error?.message;
  if(error instanceof PluginSdkError){code=error.code==='invalid_contract'?'invalid_request':error.code;}
  else if(!(error instanceof WorkspaceError)){
    const names={NotAllowedError:'permission_denied',SecurityError:'permission_denied',QuotaExceededError:'budget_exceeded',NotFoundError:'not_found',InvalidStateError:'conflict',NoModificationAllowedError:'conflict',AbortError:'cancelled'};
    code=names[error?.name]??'unavailable';message='Artifact transfer could not complete';
  }
  return new ArtifactTransferError(code,message,partial);
}
function progress(callback,value){
  if(!callback)return;const result=callback(Object.freeze(value));
  if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw workspaceFailure('invalid_request','onProgress must be synchronous');}
}
const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));

/** Browser-safe, bounded sequential download. Sink ports are trusted caller implementations. */
export function streamJobBinaryArtifact(client,value,options){return runJobBinaryArtifact(client,value,options);}
export async function runJobBinaryArtifact(client,value,options,control){
  const reference=parseBinaryArtifactReference(value);
  exactObject(options,['sink'],['signal','timeoutMs','requestTimeoutMs','onProgress']);
  const {sink,signal,timeoutMs=ARTIFACT_TRANSFER_LIMITS.timeoutMs,requestTimeoutMs=WORKSPACE_LIMITS.defaultTimeoutMs,onProgress}=options;
  integer(timeoutMs,ARTIFACT_TRANSFER_LIMITS.timeoutMs,1);integer(requestTimeoutMs,WORKSPACE_LIMITS.maxTimeoutMs,1);
  if(signal!==undefined&&!(signal instanceof AbortSignal)||onProgress!==undefined&&typeof onProgress!=='function'||!sink||typeof sink.open!=='function'||!client||['getBinaryArtifactCapabilities','getJobBinaryArtifact','readJobBinaryArtifactChunk'].some(key=>typeof client[key]!=='function'))throw workspaceFailure('invalid_request','Invalid stream download options');
  const capabilities=parseArtifactSinkCapabilities(sink.capabilities),binding=client.binding,controller=new AbortController();
  const abort=()=>controller.abort(workspaceFailure('cancelled','Artifact transfer cancelled'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const expiresAt=Date.now()+timeoutMs;
  const timer=setTimeout(()=>controller.abort(workspaceFailure('budget_exceeded','Artifact transfer deadline exceeded')),timeoutMs);
  const current=()=>{
    if(Date.now()>=expiresAt&&!controller.signal.aborted)controller.abort(workspaceFailure('budget_exceeded','Artifact transfer deadline exceeded'));
    if(controller.signal.aborted)throw controller.signal.reason;
    if(!binding||client.binding!==binding)throw workspaceFailure('disposed','Artifact transfer connection changed');
    if(reference.scope.projectId!==binding.workspace.id||reference.scope.sessionId!==binding.workspace.generation)throw workspaceFailure('generation_mismatch','Artifact belongs to another workspace generation');
  };
  const requestOptions={signal:controller.signal,timeoutMs:requestTimeoutMs},started=performance.now();
  const step=(run,metadata={})=>control?control.step(async()=>{current();return run();},metadata,controller.signal):run();
  const partial={receivedBytes:0,writtenBytes:0,receivedVerified:false,storedVerified:false,commit:'not-committed',disposition:'unknown'};
  const metrics={chunks:0,peakQueuedChunks:0,peakDecodedBytes:0,maxChunkWorkMs:0,elapsedMs:0};
  let session,registered=false;
  try{
    current();
    if(active.has(sink))throw workspaceFailure('conflict','This sink is already in use');
    if(!control&&active.size>=ARTIFACT_TRANSFER_LIMITS.concurrent)throw workspaceFailure('budget_exceeded','Artifact transfer capacity exceeded');
    active.add(sink);registered=true;
    const caps=parseBinaryArtifactCapabilities(await step(()=>client.getBinaryArtifactCapabilities(requestOptions),{phase:'preparing'}));current();
    if(!caps.enabled)throw workspaceFailure('unsupported','This host has not enabled binary artifacts');
    if(reference.artifact.byteLength>caps.limits.fileBytes)throw workspaceFailure('budget_exceeded','Artifact exceeds the host file budget');
    const fresh=parseBinaryArtifactReference(await step(()=>client.getJobBinaryArtifact(reference.jobId,reference.artifact.id,requestOptions),{phase:'preparing'}));current();
    if(!storageEqual(fresh,reference))throw workspaceFailure('conflict','Artifact reference changed');
    session=await step(()=>sink.open({artifact:reference.artifact,signal:controller.signal}),{phase:'preparing'});current();
    if(!session||['write','commit','abort'].some(key=>typeof session[key]!=='function')||capabilities.readback&&typeof session.readback!=='function')throw workspaceFailure('invalid_request','Invalid artifact sink session');
    const hash=createIncrementalSha256();let offset=0;
    for(;;){
      let eof,retryError;
      await step(async()=>{
      retryError=undefined;let raw;try{raw=await client.readJobBinaryArtifactChunk(reference,offset,{...requestOptions,length:caps.limits.chunkBytes});}catch(error){retryError=error;throw error;}current();
      const workStarted=performance.now(),response=parseBinaryArtifactChunk(raw);
      const {jobId,scope,artifact,...chunk}=response;
      if(!storageEqual({jobId,scope,artifact},reference)||chunk.offset!==offset||chunk.nextOffset!==offset+Math.min(caps.limits.chunkBytes,reference.artifact.byteLength-offset))throw workspaceFailure('invalid_request','Artifact chunk identity or range mismatch');
      const bytes=decodeBinaryArtifactData(chunk.data);
      if(createIncrementalSha256().update(bytes).digest()!==chunk.sha256)throw workspaceFailure('conflict','Artifact chunk SHA-256 mismatch');
      hash.update(bytes);partial.receivedBytes+=bytes.length;metrics.chunks++;metrics.peakQueuedChunks=1;metrics.peakDecodedBytes=Math.max(metrics.peakDecodedBytes,bytes.length);metrics.maxChunkWorkMs=Math.max(metrics.maxChunkWorkMs,performance.now()-workStarted);
      // Do not request the next chunk until the sink has accepted this one.
      await session.write({offset,bytes,signal:controller.signal});partial.writtenBytes+=bytes.length;current();offset=chunk.nextOffset;
      progress(onProgress,{phase:'receiving',receivedBytes:partial.receivedBytes,writtenBytes:partial.writtenBytes,totalBytes:artifact.byteLength,resumedBytes:0,verified:false});current();
      eof=chunk.eof;
      },{phase:'receiving',bytes:Math.min(caps.limits.chunkBytes,reference.artifact.byteLength-offset),canRetry:error=>error===retryError});
      await yieldTask();current();if(eof)break;
    }
    const receivedSha256=hash.digest();
    if(receivedSha256!==reference.artifact.revision)throw workspaceFailure('conflict','Whole artifact SHA-256 mismatch');
    partial.receivedVerified=true;progress(onProgress,{phase:'committing',receivedBytes:partial.receivedBytes,writtenBytes:partial.writtenBytes,totalBytes:reference.artifact.byteLength,resumedBytes:0,verified:false});current();
    await step(async()=>{partial.commit='unknown';await session.commit({signal:controller.signal});partial.commit='committed';current();},{phase:'committing'});
    let storedSha256=null;
    if(capabilities.readback){
      progress(onProgress,{phase:'verifying-storage',receivedBytes:partial.receivedBytes,writtenBytes:partial.writtenBytes,totalBytes:reference.artifact.byteLength,resumedBytes:0,verified:false});current();
      const reader=await step(()=>session.readback({signal:controller.signal}),{phase:'verifying-storage'});current();
      if(!reader||reader.byteLength!==reference.artifact.byteLength||typeof reader.read!=='function')throw workspaceFailure('conflict','Stored artifact size changed');
      const storedHash=createIncrementalSha256();let offset=0;
      while(offset<reader.byteLength){
        await step(async()=>{
        const length=Math.min(ARTIFACT_TRANSFER_LIMITS.chunkBytes,reader.byteLength-offset),bytes=await reader.read(offset,length,{signal:controller.signal});current();
        if(!(bytes instanceof Uint8Array)||bytes.length!==length)throw workspaceFailure('conflict','Stored artifact readback changed');
        const workStarted=performance.now();storedHash.update(bytes);metrics.maxChunkWorkMs=Math.max(metrics.maxChunkWorkMs,performance.now()-workStarted);offset+=bytes.length;
        },{phase:'verifying-storage'});await yieldTask();current();
      }
      storedSha256=storedHash.digest();if(storedSha256!==reference.artifact.revision)throw workspaceFailure('conflict','Stored artifact SHA-256 mismatch');partial.storedVerified=true;
    }
    if(typeof session.close==='function'){await step(()=>session.close(),{phase:'verifying-storage'});current();}
    metrics.elapsedMs=performance.now()-started;
    const receipt=parseArtifactTransferReceipt({protocolVersion:1,artifact:reference.artifact,receivedBytes:partial.receivedBytes,resumedBytes:0,receivedSha256,storedSha256,verification:storedSha256===null?'received':'stored',committed:true,sink:capabilities,metrics});
    progress(onProgress,{phase:'completed',receivedBytes:partial.receivedBytes,writtenBytes:partial.writtenBytes,totalBytes:reference.artifact.byteLength,resumedBytes:0,verified:true});current();return receipt;
  }catch(error){
    if(session&&typeof session.abort==='function'){
      try{await session.abort({reason:controller.signal.aborted?controller.signal.reason:error});partial.disposition=partial.commit==='not-committed'?({discard:'discarded',retain:'retained',unknown:'unknown'}[capabilities.abort]):'retained';}catch{partial.disposition='unknown';}
    }
    throw transferFailure(controller.signal.aborted?controller.signal.reason:error,partial);
  }finally{if(registered)active.delete(sink);clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

/** Current approved snapshot reference is required; tokens and grants are never restored here. */
export function streamStoredJobArtifact(client,value,options){return runStoredJobArtifact(client,value,options);}
export async function runStoredJobArtifact(client,value,options,control){
  const reference=parseStoredArtifactReference(value),s=reference.snapshot;
  if(!client||['getArtifactStorageCapabilities','getStoredJobArtifact','readStoredJobArtifactChunk'].some(key=>typeof client[key]!=='function'))throw workspaceFailure('invalid_request','A connected storage client is required');
  const legacy={jobId:s.jobId,scope:reference.scope,artifact:s.artifact};
  const bridge={
    get binding(){return client.binding;},
    async getBinaryArtifactCapabilities(requestOptions){const caps=parseArtifactStorageCapabilities(await client.getArtifactStorageCapabilities(requestOptions));return{protocolVersion:1,enabled:caps.enabled,limits:{fileBytes:caps.limits.fileBytes,chunkBytes:caps.limits.chunkBytes,artifacts:16,concurrent:caps.limits.concurrent}};},
    async getJobBinaryArtifact(_jobId,_artifactId,requestOptions){const current=parseStoredArtifactReference(await client.getStoredJobArtifact(s.pluginId,s.jobId,s.artifact.id,s.pluginArtifactSha256,requestOptions));if(!storageEqual(current,reference))throw workspaceFailure('conflict','Stored artifact identity changed');return legacy;},
    async readJobBinaryArtifactChunk(_reference,offset,requestOptions){const result=parseStoredArtifactChunk(await client.readStoredJobArtifactChunk(reference,offset,requestOptions));if(!storageEqual(result.reference,reference))throw workspaceFailure('conflict','Stored artifact identity changed');const {reference:_,...chunk}=result;return{...legacy,...chunk};},
  };
  return runJobBinaryArtifact(bridge,legacy,options,control);
}
