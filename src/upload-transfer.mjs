import {UPLOAD_LIMITS,EMPTY_UPLOAD_SHA256,parseUploadSpec,parseUploadStatus,parseUploadCapabilities,uploadInteger} from './uploads.mjs';
import {createIncrementalSha256} from './sha256-stream.mjs';
import {storageEqual} from './job-storage-validation.mjs';
import {exactObject,workspaceFailure} from './workspace-values.mjs';
let active=0;
const base64=bytes=>{let text='';for(let n=0;n<bytes.length;n+=8192)text+=String.fromCharCode(...bytes.subarray(n,n+8192));return btoa(text);};
export function validateUploadSourceRange(size,offset,length){uploadInteger(offset,size);uploadInteger(length,UPLOAD_LIMITS.chunkBytes,1);if(offset+length>size)throw workspaceFailure('invalid_request','Upload source range exceeds selected file');}
/** Prehash and sequentially upload one explicitly selected source. No retry or rollback is inferred. */
export function uploadFile(client,source,configuration){return runUploadFile(client,source,configuration);}
// The queue uses the same verifier, with private scheduling at bounded stage boundaries.
export async function runUploadFile(client,source,configuration,control){
  exactObject(configuration,['uploadId','pluginId','artifactSha256','path','expectedRevision'],['recover','signal','timeoutMs','requestTimeoutMs','onProgress']);
  const {recover=false,signal,timeoutMs=1_800_000,requestTimeoutMs=UPLOAD_LIMITS.timeoutMs,onProgress,...selected}=configuration;
  if(typeof recover!=='boolean'||signal!==undefined&&!(signal instanceof AbortSignal)||onProgress!==undefined&&typeof onProgress!=='function')throw workspaceFailure('invalid_request','Invalid upload transfer options');
  uploadInteger(timeoutMs,1_800_000,1);uploadInteger(requestTimeoutMs,UPLOAD_LIMITS.timeoutMs,1);
  if(!source||typeof source.read!=='function')throw workspaceFailure('invalid_request','Select an upload source');const byteLength=uploadInteger(source.byteLength,UPLOAD_LIMITS.fileBytes);
  const selection=parseUploadSpec({...selected,byteLength,sha256:EMPTY_UPLOAD_SHA256});
  const binding=client?.binding;if(!binding)throw workspaceFailure('unavailable','Connect before selecting an upload destination');
  if(!control&&active>=UPLOAD_LIMITS.active)throw workspaceFailure('budget_exceeded','Upload transfer capacity exceeded');if(!control)active++;
  const controller=new AbortController(),deadline=Date.now()+timeoutMs,onAbort=()=>controller.abort(workspaceFailure('cancelled','Upload cancelled'));
  const timer=setTimeout(()=>controller.abort(workspaceFailure('budget_exceeded','Upload deadline exceeded')),timeoutMs);signal?.addEventListener('abort',onAbort,{once:true});
  const options={signal:controller.signal,timeoutMs:requestTimeoutMs};let status;
  const step=(run,metadata={})=>control?control.step(async()=>{check();return run();},metadata,controller.signal):run();
  function check(){if(signal?.aborted)onAbort();if(controller.signal.aborted)throw controller.signal.reason;if(Date.now()>=deadline)throw workspaceFailure('budget_exceeded','Upload deadline exceeded');if(client.binding!==binding)throw workspaceFailure('disposed','Upload connection changed');}
  const progress=(phase,completed)=>{check();const result=onProgress?.(Object.freeze({phase,completed,total:byteLength,status}));if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw workspaceFailure('invalid_request','onProgress must be synchronous');}check();};
  async function bytes(offset,length){check();const result=await source.read(offset,length,{signal:controller.signal});check();if(!(result instanceof Uint8Array)||result.length!==length||typeof SharedArrayBuffer!=='undefined'&&result.buffer instanceof SharedArrayBuffer)throw workspaceFailure('conflict','Selected upload source changed');return result;}
  async function hashPrefix(length,phase){const hash=createIncrementalSha256();for(let offset=0;offset<length;)await step(async()=>{const value=await bytes(offset,Math.min(UPLOAD_LIMITS.chunkBytes,length-offset));hash.update(value);offset+=value.length;progress(phase,offset);},{phase});return hash.digest();}
  try{
    check();const capabilities=parseUploadCapabilities(await step(()=>client.getUploadCapabilities(options),{phase:'preparing'}));check();if(!capabilities.enabled)throw workspaceFailure('unsupported','Uploads are unavailable');if(byteLength>capabilities.limits.fileBytes)throw workspaceFailure('budget_exceeded','Selected file exceeds host limit');
    const sha256=await hashPrefix(byteLength,'hashing'),spec=parseUploadSpec({...selection,sha256});
    if(recover){try{status=await step(()=>client.queryUpload({uploadId:spec.uploadId,pluginId:spec.pluginId,artifactSha256:spec.artifactSha256,recover:true},options),{phase:'preparing',uploadSlots:capabilities.limits.active});}catch(error){if(error.code!=='not_found')throw error;}}
    status=parseUploadStatus(status??await step(()=>client.beginUpload(spec,options),{phase:'preparing',uploadSlots:capabilities.limits.active}));check();if(!storageEqual(status.reference.spec,spec))throw workspaceFailure('conflict','Upload id belongs to another selected file or destination');
    if(status.state==='committed'){progress('committed',byteLength);return status;}
    if(status.state!=='receiving')throw workspaceFailure('conflict','Upload is not resumable');
    progress('verifying-prefix',0);if(await hashPrefix(status.offset,'verifying-prefix')!==status.prefixSha256)throw workspaceFailure('conflict','Selected file does not match the saved upload prefix');
    while(status.offset<byteLength){const offset=status.offset,length=Math.min(capabilities.limits.chunkBytes,byteLength-offset);let previousDigest,retryError;
      await step(async()=>{retryError=undefined;const value=await bytes(offset,length),sha256=createIncrementalSha256().update(value).digest();
        if(previousDigest!==undefined&&previousDigest!==sha256)throw workspaceFailure('conflict','Selected upload source changed before retry');previousDigest=sha256;
        let raw;try{raw=await client.writeUploadChunk(status.reference,{offset,data:base64(value),sha256},options);}catch(error){retryError=error;throw error;}
        status=parseUploadStatus(raw);check();if(status.offset!==offset+value.length)throw workspaceFailure('conflict','Another writer advanced this upload');progress('uploading',status.offset);
      },{phase:'uploading',bytes:length,canRetry:error=>error===retryError});
    }
    progress('committing',byteLength);status=parseUploadStatus(await step(()=>client.commitUpload(status.reference,options),{phase:'committing'}));check();progress('committed',byteLength);return status;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(!control)active--;}
}
