import {parseStoredArtifact,parseStoredArtifactReference} from './artifact-storage.mjs';
import {parseBinaryArtifact} from './artifacts.mjs';
import {parseArtifactSinkCapabilities} from './artifact-transfer.mjs';
import {createIncrementalSha256,snapshotSha256} from './sha256-stream.mjs';
import {storageEqual} from './job-storage-validation.mjs';
import {workspaceFailure,exactObject,copyWorkspaceJson,requireUuid,requireSha256} from './workspace-values.mjs';

export const BROWSER_ARTIFACT_RESUME_LIMITS=Object.freeze({fileBytes:1_073_741_824,chunkBytes:65_536,metadataBytes:16_384,concurrent:4,retentionMs:86_400_000});
export const DEFAULT_BROWSER_ARTIFACT_RETENTION_MS=3_600_000;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const active=new Set(),emptySha=createIncrementalSha256().digest();
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(v)||v<min||v>max)throw workspaceFailure('invalid_request','Invalid browser checkpoint number');return v;};
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const checksum=value=>createIncrementalSha256().update(encoder.encode(canonical(value))).digest();
const signalCheck=signal=>{if(signal?.aborted)throw workspaceFailure('cancelled','Browser checkpoint operation cancelled');};
const yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0));
function checkpoint(value,size){exactObject(value,['offset','sha256']);integer(value.offset,0,size);requireSha256(value.sha256);if(value.offset===0&&value.sha256!==emptySha)throw workspaceFailure('invalid_request','Invalid empty checkpoint');}
export function parseBrowserArtifactCheckpoint(value){
  const v=copyWorkspaceJson(value,{maxBytes:BROWSER_ARTIFACT_RESUME_LIMITS.metadataBytes});
  exactObject(v,['schemaVersion','partialId','snapshot','createdAt','updatedAt','expiresAt','state','checkpoint','previousCheckpoint','checksum']);
  if(v.schemaVersion!==1||!['partial','complete'].includes(v.state))throw workspaceFailure('invalid_request','Invalid browser checkpoint state');
  requireUuid(v.partialId);const s=parseStoredArtifact(v.snapshot);requireSha256(v.checksum);
  integer(v.createdAt);integer(v.updatedAt,v.createdAt);integer(v.expiresAt,v.createdAt+1,Math.min(v.createdAt+BROWSER_ARTIFACT_RESUME_LIMITS.retentionMs,s.expiresAt));
  if(v.updatedAt>=v.expiresAt)throw workspaceFailure('invalid_request','Invalid browser checkpoint time');
  checkpoint(v.checkpoint,s.artifact.byteLength);
  if(v.previousCheckpoint!==null){checkpoint(v.previousCheckpoint,s.artifact.byteLength);if(v.previousCheckpoint.offset>=v.checkpoint.offset)throw workspaceFailure('invalid_request','Invalid previous checkpoint');}
  if(v.state==='complete'&&(v.checkpoint.offset!==s.artifact.byteLength||v.checkpoint.sha256!==s.artifact.revision))throw workspaceFailure('invalid_request','Invalid completed checkpoint');
  const {checksum:expected,...body}=v;
  if(checksum(body)!==expected||encoder.encode(JSON.stringify(v)).length>BROWSER_ARTIFACT_RESUME_LIMITS.metadataBytes)throw workspaceFailure('conflict','Browser checkpoint checksum mismatch');
  return v;
}
export function getOpfsArtifactPartialNames(partialId){requireUuid(partialId);return Object.freeze({data:`dds-partial-${partialId}.data`,metadata:`dds-partial-${partialId}.json`});}
export function getBrowserArtifactResumeSupport(){
  const dedicatedWorker=typeof DedicatedWorkerGlobalScope!=='undefined'&&globalThis instanceof DedicatedWorkerGlobalScope;
  const syncAccess=typeof FileSystemFileHandle!=='undefined'&&typeof FileSystemFileHandle.prototype.createSyncAccessHandle==='function';
  const webLocks=typeof globalThis.navigator?.locks?.request==='function';
  return Object.freeze({supported:dedicatedWorker&&syncAccess&&webLocks,dedicatedWorker,syncAccess,webLocks});
}
async function findFile(directory,name){try{return await directory.getFileHandle(name);}catch(error){if(error?.name==='NotFoundError')return null;throw error;}}
async function readMetadata(handle){
  const file=await handle.getFile();
  if(file.size<1||file.size>BROWSER_ARTIFACT_RESUME_LIMITS.metadataBytes)throw workspaceFailure('conflict','Missing or oversized browser checkpoint');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size)throw workspaceFailure('conflict','Browser checkpoint size changed');
  try{const text=decoder.decode(bytes);return{text,value:parseBrowserArtifactCheckpoint(JSON.parse(text))};}
  catch(error){if(error?.code)throw error;throw workspaceFailure('conflict','Malformed browser checkpoint');}
}
async function holdLock(locks,name,signal){
  let resolveAcquired,rejectAcquired,release;
  const acquired=new Promise((resolve,reject)=>{resolveAcquired=resolve;rejectAcquired=reject;});
  const held=new Promise(resolve=>{release=resolve;});
  // Web Locks forbids combining ifAvailable and signal. No waiting queue or lock stealing.
  const task=Promise.resolve().then(()=>locks.request(name,{mode:'exclusive',ifAvailable:true},async lock=>{
    if(!lock)throw workspaceFailure('conflict','Another tab or worker owns this partial');
    signalCheck(signal);resolveAcquired();await held;
  }));
  task.catch(rejectAcquired);
  await acquired;
  return async()=>{release();await task;};
}

/** Native use requires an OPFS directory in a dedicated Worker. Structural ports are trusted. */
export function createOpfsArtifactSink(options){
  exactObject(options,['directory','partialId','reference'],['retentionMs','locks']);
  const {directory,partialId,retentionMs=DEFAULT_BROWSER_ARTIFACT_RETENTION_MS}=options;
  const reference=parseStoredArtifactReference(options.reference),snapshot=reference.snapshot,names=getOpfsArtifactPartialNames(partialId),locks=options.locks??globalThis.navigator?.locks;
  integer(retentionMs,1,BROWSER_ARTIFACT_RESUME_LIMITS.retentionMs);
  if(!directory||directory.kind!=='directory'||typeof directory.getFileHandle!=='function'||typeof locks?.request!=='function')throw workspaceFailure('unsupported','OPFS directory and Web Locks are required');
  if(typeof Window!=='undefined'&&globalThis instanceof Window||typeof FileSystemFileHandle!=='undefined'&&typeof FileSystemFileHandle.prototype.createSyncAccessHandle!=='function')throw workspaceFailure('unsupported','Persistent OPFS downloads require a dedicated Worker');
  const capabilities=parseArtifactSinkCapabilities({kind:'opfs',seek:true,readback:true,persistence:'per-checkpoint',abort:'retain'});
  return Object.freeze({capabilities,partialId,names,async open(input){
    exactObject(input,['artifact','signal','storedReference'],['resume']);
    const {signal,resume=false}=input;
    if(typeof resume!=='boolean'||!(signal instanceof AbortSignal))throw workspaceFailure('invalid_request','Invalid checkpoint open options');
    if(!storageEqual(parseBinaryArtifact(input.artifact),snapshot.artifact)||!storageEqual(parseStoredArtifactReference(input.storedReference),reference))throw workspaceFailure('conflict','Current approved artifact reference differs from the selected partial');
    signalCheck(signal);
    if(Date.now()>=snapshot.expiresAt)throw workspaceFailure('unavailable','Stored artifact has expired');
    if(active.size>=BROWSER_ARTIFACT_RESUME_LIMITS.concurrent)throw workspaceFailure('budget_exceeded','Browser checkpoint capacity exceeded');
    const ticket={};active.add(ticket);
    let releaseLock,access,metadataHandle,dataHandle,record,expectedText,hash,offset=0,closed=false,poisoned=false,busy=false,closing=false,closePromise,pendingOperation;
    const close=()=>{
      if(closePromise)return closePromise;closing=true;
      closePromise=(async()=>{
        // A metadata close already in flight may still publish. Retain ownership until it settles.
        try{await pendingOperation;}catch{}
        closed=true;try{access?.close();}finally{try{await releaseLock?.();}finally{active.delete(ticket);}}
      })();return closePromise;
    };
    function current(operationSignal){
      signalCheck(signal);signalCheck(operationSignal);
      if(closed||closing||poisoned)throw workspaceFailure('disposed','Browser checkpoint session is closed or requires recovery');
      if(Date.now()>=(record?.expiresAt??snapshot.expiresAt))throw workspaceFailure('unavailable','Browser checkpoint has expired');
    }
    async function unchanged(){
      if(expectedText===undefined)return;
      if((await readMetadata(metadataHandle)).text!==expectedText)throw workspaceFailure('conflict','Browser checkpoint changed outside this session');
    }
    async function save(body,operationSignal){
      current(operationSignal);await unchanged();current(operationSignal);
      const next=parseBrowserArtifactCheckpoint({...body,checksum:checksum(body)}),text=JSON.stringify(next),bytes=encoder.encode(text);
      let writable;
      try{
        writable=await metadataHandle.createWritable({keepExistingData:false});current(operationSignal);
        await writable.write(bytes);current(operationSignal);await writable.close();
        const observed=await readMetadata(metadataHandle);
        if(observed.text!==text)throw workspaceFailure('conflict','Browser checkpoint did not persist the expected bytes');
        record=next;expectedText=text;current(operationSignal);
      }catch(error){poisoned=true;try{await writable?.abort();}catch{}throw error;}
    }
    const read=(at,length,maximum)=>{
      integer(at,0,maximum);integer(length,0,BROWSER_ARTIFACT_RESUME_LIMITS.chunkBytes);
      if(at+length>maximum)throw workspaceFailure('invalid_request','Checkpoint read is out of range');
      const bytes=new Uint8Array(length);
      if(access.read(bytes,{at})!==length)throw workspaceFailure('conflict','Browser partial size changed');return bytes;
    };
    const operation=(operationSignal,run)=>{
      try{current(operationSignal);if(busy)throw workspaceFailure('conflict','Concurrent checkpoint operations are not supported');}catch(error){return Promise.reject(error);}busy=true;
      pendingOperation=(async()=>{try{await unchanged();current(operationSignal);return await run();}finally{busy=false;}})();return pendingOperation;
    };
    try{
      releaseLock=await holdLock(locks,`dds-artifact-partial:${partialId}`,signal);current(signal);
      dataHandle=await findFile(directory,names.data);metadataHandle=await findFile(directory,names.metadata);current(signal);
      if(resume&&(!dataHandle||!metadataHandle))throw workspaceFailure('not_found','The selected browser partial or checkpoint is missing');
      if(!resume&&(dataHandle||metadataHandle))throw workspaceFailure('conflict','This partial ID already exists; select explicit recovery or a new ID');
      if(!resume){dataHandle=await directory.getFileHandle(names.data,{create:true});metadataHandle=await directory.getFileHandle(names.metadata,{create:true});}
      if(typeof dataHandle.createSyncAccessHandle!=='function')throw workspaceFailure('unsupported','Selected file does not support Worker sync access');
      access=await dataHandle.createSyncAccessHandle();current(signal);
      hash=createIncrementalSha256();
      if(resume){
        const saved=await readMetadata(metadataHandle);record=saved.value;expectedText=saved.text;current(signal);
        if(record.partialId!==partialId||!storageEqual(record.snapshot,snapshot))throw workspaceFailure('conflict','Browser partial belongs to a different stored artifact');
        const size=integer(access.getSize(),0,BROWSER_ARTIFACT_RESUME_LIMITS.fileBytes);
        let selected=record.checkpoint,fallback=false;
        if(selected.offset>size){selected=record.previousCheckpoint;fallback=true;if(!selected||selected.offset>size)throw workspaceFailure('conflict','Browser partial is shorter than its recoverable checkpoints');}
        while(offset<selected.offset){current(signal);const bytes=read(offset,Math.min(BROWSER_ARTIFACT_RESUME_LIMITS.chunkBytes,selected.offset-offset),selected.offset);hash.update(bytes);offset+=bytes.length;await yieldTask();}
        if(snapshotSha256(hash)!==selected.sha256)throw workspaceFailure('conflict','Browser partial prefix SHA-256 mismatch');
        await unchanged();current(signal);
        if(size!==offset){access.truncate(offset);access.flush();}
        if(fallback){const {checksum:_,...body}=record;await save({...body,state:'partial',checkpoint:selected,previousCheckpoint:null,updatedAt:Math.max(record.updatedAt,Date.now())},signal);}
      }else{
        if(access.getSize()!==0)throw workspaceFailure('conflict','New browser partial is not empty');
        const now=Date.now();access.flush();
        await save({schemaVersion:1,partialId,snapshot,createdAt:now,updatedAt:now,expiresAt:Math.min(now+retentionMs,snapshot.expiresAt),state:'partial',checkpoint:{offset:0,sha256:emptySha},previousCheckpoint:null},signal);
      }
      current(signal);
      const recovered=Object.freeze({...record.checkpoint});
      return Object.freeze({
        recovery:Object.freeze({...recovered,async read(at,length,{signal:readSignal}){return operation(readSignal,()=>read(at,length,recovered.offset));}}),
        async write({offset:at,bytes,signal:writeSignal}){return operation(writeSignal,async()=>{
          if(at!==offset||!(bytes instanceof Uint8Array)||typeof SharedArrayBuffer!=='undefined'&&bytes.buffer instanceof SharedArrayBuffer||bytes.length>BROWSER_ARTIFACT_RESUME_LIMITS.chunkBytes||offset+bytes.length>snapshot.artifact.byteLength)throw workspaceFailure('invalid_request','Invalid sequential checkpoint write');
          if(access.getSize()!==offset)throw workspaceFailure('conflict','Browser partial size changed');
          if(bytes.length===0)return;
          if(record.state==='complete')throw workspaceFailure('conflict','Browser partial is already complete');
          try{
            if(access.write(bytes,{at})!==bytes.length)throw workspaceFailure('unavailable','Browser partial write was incomplete');
            access.flush();current(writeSignal);hash.update(bytes);
            const {checksum:_,...body}=record;
            await save({...body,updatedAt:Math.max(record.updatedAt,Date.now()),checkpoint:{offset:offset+bytes.length,sha256:snapshotSha256(hash)},previousCheckpoint:record.checkpoint},writeSignal);
            offset+=bytes.length;
          }catch(error){poisoned=true;throw error;}
        });},
        async commit({signal:commitSignal}){return operation(commitSignal,async()=>{
          if(offset!==snapshot.artifact.byteLength||access.getSize()!==offset||snapshotSha256(hash)!==snapshot.artifact.revision)throw workspaceFailure('conflict','Cannot complete an unverified browser partial');
          access.flush();const {checksum:_,...body}=record;
          await save({...body,state:'complete',updatedAt:Math.max(record.updatedAt,Date.now())},commitSignal);
        });},
        async readback({signal:readSignal}){return operation(readSignal,()=>{
          if(record.state!=='complete'||access.getSize()!==snapshot.artifact.byteLength)throw workspaceFailure('conflict','Browser partial is not complete');
          return Object.freeze({byteLength:offset,async read(at,length,{signal:sliceSignal}){return operation(sliceSignal,()=>read(at,length,offset));}});
        });},
        async abort(){await close();},close,
      });
    }catch(error){await close();throw error;}
  }});
}
