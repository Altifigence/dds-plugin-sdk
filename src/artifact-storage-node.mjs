import {storageEqual} from './job-storage-validation.mjs';
import * as fs from 'node:fs/promises';
import {constants as flags} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseBinaryArtifactSource,parseBinaryChunk,parseBinaryArtifactRange,decodeBinaryArtifactData} from './artifacts.mjs';
import {ARTIFACT_STORE_LIMITS,DEFAULT_ARTIFACT_STORE_BYTES,parseArtifactStoreLimits,parseStoredArtifact} from './artifact-storage.mjs';
import {DEFAULT_JOB_RETENTION_MS,parseJobStoreIdentity} from './job-storage.mjs';
import {nodeStoreContext} from './node-store-context.mjs';
import {storageObject} from './job-storage-validation.mjs';
import {ErrorCode,PluginSdkError} from './limits.mjs';

const openedStores=new WeakSet();
const failure=code=>new PluginSdkError(code,'Artifact storage operation failed');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const sameState=(a,b)=>same(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const regular=stat=>{if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)throw failure(ErrorCode.CONFLICT);};
const recordName=/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.(json|bin)$/;
const temporaryName=/^\.(?:capture|metadata)-[a-f0-9-]{36}$/;
function mapped(error){
  if(error instanceof PluginSdkError)return error;
  if(error?.code==='ENOENT')return failure(ErrorCode.CAPABILITY_UNAVAILABLE);
  if(['EEXIST','ENOTEMPTY'].includes(error?.code))return failure(ErrorCode.CONFLICT);
  if(['EACCES','EPERM'].includes(error?.code))return failure(ErrorCode.PERMISSION_DENIED);
  if(['ENOSPC','EDQUOT','EFBIG'].includes(error?.code))return failure(ErrorCode.BUDGET_EXCEEDED);
  return failure(ErrorCode.PROVIDER_FAILED);
}
function decode(bytes){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
async function cancellable(promise,signal){
  let abort;const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  try{return await Promise.race([Promise.resolve(promise),cancelled]);}finally{signal.removeEventListener('abort',abort);}
}
const envelope=record=>JSON.stringify({formatVersion:1,sha256:hash(JSON.stringify(record)),record});
function unwrap(bytes){
  const value=decode(bytes);storageObject(value,['formatVersion','sha256','record']);
  if(value.formatVersion!==1)throw failure(ErrorCode.VERSION_MISMATCH);
  if(value.sha256!==hash(JSON.stringify(value.record)))throw failure(ErrorCode.CONFLICT);
  return parseStoredArtifact(value.record);
}

/** Shares the concrete Node job store's writer lock; operator owned, outside its workspace. */
export async function createNodeArtifactStore({jobStore,maxFiles=ARTIFACT_STORE_LIMITS.files,maxBytes=DEFAULT_ARTIFACT_STORE_BYTES,maxFileBytes=ARTIFACT_STORE_LIMITS.fileBytes,retentionMs=DEFAULT_JOB_RETENTION_MS}={}){
  const context=nodeStoreContext(jobStore);
  if(!context)throw failure(ErrorCode.INVALID_CONTRACT);
  if(openedStores.has(jobStore))throw failure(ErrorCode.CONFLICT);
  const identity=parseJobStoreIdentity(jobStore.identity),limits=parseArtifactStoreLimits({...ARTIFACT_STORE_LIMITS,files:maxFiles,storeBytes:maxBytes,fileBytes:maxFileBytes,retentionMs});
  const directory=path.join(context.root,'artifacts'),records=new Map(),problems=new Map(),sizes=new Map(),readers=new Map(),verified=new Map(),orphans=new Set(),operations=new Set(),deleting=new Set();
  let initial,closed=false,closing=false,closePromise,activeReaders=0,usedBytes=0,lastCapturedAt=0;
  const assertOpen=()=>{if(closed||closing)throw failure(ErrorCode.DISPOSED);};
  const size=(name,value)=>{usedBytes+=value-(sizes.get(name)??0);if(value===null)sizes.delete(name);else sizes.set(name,value);};
  async function checkOwned(){
    if(closed)throw failure(ErrorCode.DISPOSED);await context.checkOwned();
    if(initial){const stat=await fs.lstat(directory,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||!same(stat,initial)||await fs.realpath(directory)!==directory)throw failure(ErrorCode.CONFLICT);}
  }
  function bound(record){return record.storeId===identity.storeId&&record.workspaceId===identity.workspaceId&&record.workspaceIdentity===identity.workspaceIdentity;}
  async function metadata(record){
    const current=unwrap(await context.regularBytes(path.join(directory,record.snapshotId+'.json'),65_536));
    if(!bound(current)||!storageEqual(current,record))throw failure(ErrorCode.CONFLICT);
  }
  async function removeFile(name){
    await checkOwned();const file=path.join(directory,name),stat=await fs.lstat(file,{bigint:true});regular(stat);
    await fs.unlink(file);size(name,null);orphans.delete(name);await context.syncDirectory(directory);
  }
  function operation(options,body,readId){
    assertOpen();storageObject(options,[],['signal','timeoutMs']);
    const {signal,timeoutMs=30_000}=options;
    if(signal!==undefined&&!(signal instanceof AbortSignal)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>1_800_000)throw failure(ErrorCode.INVALID_CONTRACT);
    if(signal?.aborted)throw failure(ErrorCode.CANCELLED);
    if(readId!==undefined){if(deleting.has(readId))throw failure(ErrorCode.CONFLICT);if(activeReaders>=limits.concurrent)throw failure(ErrorCode.BUDGET_EXCEEDED);activeReaders++;readers.set(readId,(readers.get(readId)??0)+1);}
    const controller=new AbortController(),abort=()=>controller.abort(failure(ErrorCode.CANCELLED));signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(failure(ErrorCode.BUDGET_EXCEEDED)),timeoutMs);
    const current=()=>{if(controller.signal.aborted)throw controller.signal.reason;if(closed)throw failure(ErrorCode.DISPOSED);};
    const promise=Promise.resolve().then(()=>body(controller.signal,current)).catch(error=>{if(controller.signal.aborted)throw controller.signal.reason;throw mapped(error);}).finally(()=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);operations.delete(promise);
      if(readId!==undefined){activeReaders--;const n=readers.get(readId)-1;if(n)readers.set(readId,n);else readers.delete(readId);}
    });
    operations.add(promise);return promise;
  }
  function status(value){
    assertOpen();const record=parseStoredArtifact(value);
    if(!bound(record))return'corrupt';
    if(problems.has(record.snapshotId))return problems.get(record.snapshotId);
    const current=records.get(record.snapshotId);
    if(!current)return'missing';
    if(!storageEqual(current,record))return'corrupt';
    return record.expiresAt<=Date.now()?'expired':'retained';
  }
  function requireRetained(record){
    const state=status(record);
    if(state!=='retained')throw failure(state==='unsupported'?ErrorCode.VERSION_MISMATCH:state==='corrupt'?ErrorCode.CONFLICT:ErrorCode.CAPABILITY_UNAVAILABLE);
  }
  async function openVerified(record,current){
    current();requireRetained(record);await checkOwned();await metadata(record);
    const file=path.join(directory,record.snapshotId+'.bin'),before=await fs.lstat(file,{bigint:true});regular(before);
    if(before.size!==BigInt(record.artifact.byteLength))throw failure(ErrorCode.CONFLICT);
    const handle=await fs.open(file,flags.O_RDONLY|(flags.O_NOFOLLOW??0));
    try{
      const opened=await handle.stat({bigint:true});regular(opened);if(!sameState(opened,before))throw failure(ErrorCode.CONFLICT);
      async function stable(){
        current();await checkOwned();const after=await handle.stat({bigint:true}),atPath=await fs.lstat(file,{bigint:true});regular(after);regular(atPath);
        if(!sameState(after,opened)||!sameState(atPath,opened))throw failure(ErrorCode.CONFLICT);
        await metadata(record);current();
      }
      if(!verified.has(record.snapshotId)||!sameState(verified.get(record.snapshotId),opened)){
        const digest=createHash('sha256'),buffer=Buffer.alloc(limits.chunkBytes);let offset=0;
        while(offset<record.artifact.byteLength){current();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,record.artifact.byteLength-offset),offset);if(!bytesRead)throw failure(ErrorCode.CONFLICT);digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
        await stable();if(digest.digest('hex')!==record.artifact.revision)throw failure(ErrorCode.CONFLICT);verified.set(record.snapshotId,opened);
      }else await stable();
      return{handle,opened,stable};
    }catch(error){await handle.close();throw error;}
  }
  async function guardedRead(record,current,read){
    let opened;
    try{opened=await openVerified(record,current);return await read(opened);}
    catch(error){if(error?.code==='ENOENT')problems.set(record.snapshotId,'missing');else if(error?.code===ErrorCode.CONFLICT)problems.set(record.snapshotId,'corrupt');throw error;}
    finally{await opened?.handle.close();}
  }
  openedStores.add(jobStore);
  try{
    await context.enqueue(async()=>{
      await context.checkOwned();try{await fs.mkdir(directory,{mode:0o700});await context.syncDirectory(context.root);}catch(error){if(error.code!=='EEXIST')throw error;}
      initial=await fs.lstat(directory,{bigint:true});if(!initial.isDirectory()||initial.isSymbolicLink()||await fs.realpath(directory)!==directory)throw failure(ErrorCode.CONFLICT);
      const names=await fs.readdir(directory);if(names.length>limits.files*2+64)throw failure(ErrorCode.BUDGET_EXCEEDED);
      for(const name of names){if(!recordName.test(name)&&!temporaryName.test(name))throw failure(ErrorCode.INVALID_CONTRACT);const stat=await fs.lstat(path.join(directory,name),{bigint:true});size(name,Number(stat.size));if(temporaryName.test(name))orphans.add(name);}
      if(usedBytes>limits.storeBytes)throw failure(ErrorCode.BUDGET_EXCEEDED);
      for(const name of names.filter(name=>recordName.test(name)&&name.endsWith('.json'))){
        const id=name.slice(0,-5);
        try{const record=unwrap(await context.regularBytes(path.join(directory,name),65_536));if(record.snapshotId!==id||!bound(record))throw failure(ErrorCode.CONFLICT);records.set(id,record);lastCapturedAt=Math.max(lastCapturedAt,record.capturedAt);if(!sizes.has(id+'.bin'))problems.set(id,'missing');}
        catch(error){problems.set(id,error?.code===ErrorCode.VERSION_MISMATCH?'unsupported':'corrupt');}
      }
      for(const name of names.filter(name=>recordName.test(name)&&name.endsWith('.bin')))if(!sizes.has(name.slice(0,-4)+'.json'))orphans.add(name);
      if(new Set([...records.keys(),...problems.keys()]).size>limits.files)throw failure(ErrorCode.BUDGET_EXCEEDED);await checkOwned();
    });
  }catch(error){openedStores.delete(jobStore);throw mapped(error);}

  const store=Object.freeze({
    identity,limits,status,
    capture(request,source,options={}){
      storageObject(request,['jobId','pluginId','pluginArtifactSha256','kind','artifact']);
      const capturedAt=Math.max(Date.now(),lastCapturedAt),record=parseStoredArtifact({...identity,...request,snapshotId:randomUUID(),capturedAt,expiresAt:capturedAt+limits.retentionMs});
      source=parseBinaryArtifactSource(source,record.artifact.path);
      if(source.revision!==record.artifact.revision||source.byteLength!==record.artifact.byteLength)throw failure(ErrorCode.CONFLICT);
      if(record.artifact.byteLength>limits.fileBytes)throw failure(ErrorCode.BUDGET_EXCEEDED);
      return operation(options,(signal,current)=>context.enqueue(async()=>{
        current();await checkOwned();const meta=envelope(record),metaBytes=Buffer.byteLength(meta);
        if(new Set([...records.keys(),...problems.keys()]).size>=limits.files||usedBytes+record.artifact.byteLength+metaBytes>limits.storeBytes)throw failure(ErrorCode.BUDGET_EXCEEDED);
        const temp='.capture-'+record.snapshotId,metaTemp='.metadata-'+record.snapshotId,blobName=record.snapshotId+'.bin',metaName=record.snapshotId+'.json';
        let handle,metaHandle,published=false,committed=false;
        try{
          handle=await fs.open(path.join(directory,temp),flags.O_RDWR|flags.O_CREAT|flags.O_EXCL|(flags.O_NOFOLLOW??0),0o600);size(temp,0);orphans.add(temp);
          const digest=createHash('sha256');let offset=0;
          for(;;){
            current();await checkOwned();
            const chunk=parseBinaryChunk(await cancellable(source.readChunk(offset,limits.chunkBytes,{signal}),signal),record.artifact.byteLength),bytes=decodeBinaryArtifactData(chunk.data);
            current();if(chunk.offset!==offset||chunk.nextOffset!==offset+Math.min(limits.chunkBytes,record.artifact.byteLength-offset)||hash(bytes)!==chunk.sha256)throw failure(ErrorCode.CONFLICT);
            let written=0;while(written<bytes.length){current();const result=await handle.write(bytes,written,bytes.length-written,offset+written);if(!result.bytesWritten)throw failure(ErrorCode.PROVIDER_FAILED);written+=result.bytesWritten;size(temp,offset+written);}
            digest.update(bytes);offset=chunk.nextOffset;if(chunk.eof)break;
          }
          if(offset!==record.artifact.byteLength||digest.digest('hex')!==record.artifact.revision)throw failure(ErrorCode.CONFLICT);
          current();await checkOwned();await handle.sync();const state=await handle.stat({bigint:true});regular(state);if(state.size!==BigInt(offset))throw failure(ErrorCode.CONFLICT);
          // Hash the actual staging file as well as the incoming stream.
          const staged=createHash('sha256'),buffer=Buffer.alloc(limits.chunkBytes);let checked=0;
          while(checked<offset){current();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,offset-checked),checked);if(!bytesRead)throw failure(ErrorCode.CONFLICT);staged.update(buffer.subarray(0,bytesRead));checked+=bytesRead;}
          const after=await handle.stat({bigint:true}),atPath=await fs.lstat(path.join(directory,temp),{bigint:true});regular(after);regular(atPath);
          if(!sameState(after,state)||!sameState(atPath,state)||staged.digest('hex')!==record.artifact.revision)throw failure(ErrorCode.CONFLICT);
          await handle.close();handle=undefined;current();await checkOwned();
          // Publish without replacing an existing file; unlink restores a single link.
          await fs.link(path.join(directory,temp),path.join(directory,blobName));published=true;
          const linked=await fs.lstat(path.join(directory,blobName),{bigint:true}),remaining=await fs.lstat(path.join(directory,temp),{bigint:true});
          if(linked.isSymbolicLink()||remaining.isSymbolicLink()||!same(linked,state)||!same(remaining,state)||linked.nlink!==2n)throw failure(ErrorCode.CONFLICT);
          await fs.unlink(path.join(directory,temp));sizes.delete(temp);sizes.set(blobName,offset);orphans.delete(temp);orphans.add(blobName);await context.syncDirectory(directory);
          current();await checkOwned();
          metaHandle=await fs.open(path.join(directory,metaTemp),flags.O_WRONLY|flags.O_CREAT|flags.O_EXCL|(flags.O_NOFOLLOW??0),0o600);size(metaTemp,0);orphans.add(metaTemp);
          await metaHandle.writeFile(meta);size(metaTemp,metaBytes);await metaHandle.sync();await metaHandle.close();metaHandle=undefined;
          current();await checkOwned();await fs.link(path.join(directory,metaTemp),path.join(directory,metaName));
          const writtenMeta=await fs.lstat(path.join(directory,metaName),{bigint:true}),stagingMeta=await fs.lstat(path.join(directory,metaTemp),{bigint:true});
          if(writtenMeta.isSymbolicLink()||stagingMeta.isSymbolicLink()||!same(writtenMeta,stagingMeta)||writtenMeta.nlink!==2n)throw failure(ErrorCode.CONFLICT);
          await fs.unlink(path.join(directory,metaTemp));sizes.delete(metaTemp);sizes.set(metaName,metaBytes);orphans.delete(metaTemp);await context.syncDirectory(directory);
          await checkOwned();await metadata(record);
          const final=await fs.lstat(path.join(directory,blobName),{bigint:true});regular(final);if(!same(final,state)||final.size!==state.size||final.mtimeNs!==state.mtimeNs)throw failure(ErrorCode.CONFLICT);
          committed=true;records.set(record.snapshotId,record);verified.set(record.snapshotId,final);orphans.delete(blobName);lastCapturedAt=record.capturedAt;
          current();return record;
        }finally{
          await handle?.close();await metaHandle?.close();
          if(!committed){
            // Leave a fully published but unacknowledged pair for explicit inspection.
            // Only our remaining single-link temporaries are safe to remove here.
            for(const name of [temp,metaTemp])if(sizes.has(name)){await checkOwned();const stat=await fs.lstat(path.join(directory,name),{bigint:true});if(stat.nlink===1n)await removeFile(name);}
            if(published&&!sizes.has(blobName)){
              await checkOwned();const stat=await fs.lstat(path.join(directory,blobName),{bigint:true});size(blobName,Number(stat.size));orphans.add(blobName);
            }
          }
        }
      }));
    },
    verify(value,options={}){
      const record=parseStoredArtifact(value);
      return operation(options,(_signal,current)=>guardedRead(record,current,async opened=>{await opened.stable();return record;}),record.snapshotId);
    },
    readChunk(value,offset,length,options={}){
      const record=parseStoredArtifact(value);parseBinaryArtifactRange(offset,length,record.artifact.byteLength);if(length>limits.chunkBytes)throw failure(ErrorCode.BUDGET_EXCEEDED);
      return operation(options,(_signal,current)=>guardedRead(record,current,async opened=>{
        const bytes=Buffer.alloc(Math.min(length,record.artifact.byteLength-offset));let received=0;
        while(received<bytes.length){current();const result=await opened.handle.read(bytes,received,bytes.length-received,offset+received);if(!result.bytesRead)throw failure(ErrorCode.CONFLICT);received+=result.bytesRead;}
        await opened.stable();return parseBinaryChunk({offset,nextOffset:offset+received,eof:offset+received===record.artifact.byteLength,data:bytes.toString('base64'),sha256:hash(bytes)},record.artifact.byteLength);
      }),record.snapshotId);
    },
    remove(value){
      assertOpen();const record=parseStoredArtifact(value);
      const promise=context.enqueue(async()=>{
        if(readers.has(record.snapshotId)||context.isJobPinned(record.jobId))throw failure(ErrorCode.CONFLICT);
        deleting.add(record.snapshotId);
        try{
          await checkOwned();const old=records.get(record.snapshotId);if(!old||!storageEqual(old,record))throw failure(ErrorCode.CONFLICT);await metadata(record);
          // Removing metadata first makes a crash leave an explicit orphan blob.
          await removeFile(record.snapshotId+'.json');records.delete(record.snapshotId);problems.delete(record.snapshotId);verified.delete(record.snapshotId);orphans.add(record.snapshotId+'.bin');
          try{await removeFile(record.snapshotId+'.bin');}catch(error){if(error.code!=='ENOENT')throw error;size(record.snapshotId+'.bin',null);orphans.delete(record.snapshotId+'.bin');}
          return Object.freeze({snapshotId:record.snapshotId,removed:true});
        }finally{deleting.delete(record.snapshotId);}
      }).catch(error=>{throw mapped(error);}).finally(()=>operations.delete(promise));
      operations.add(promise);return promise;
    },
    async prune({orphans:removeOrphans=false}={}){
      assertOpen();if(typeof removeOrphans!=='boolean')throw failure(ErrorCode.INVALID_CONTRACT);
      const removed=[],retained=[];
      for(const record of [...records.values()])if(record.expiresAt<=Date.now()){
        if(readers.has(record.snapshotId)||context.isJobPinned(record.jobId)){retained.push(record.snapshotId);continue;}
        try{await store.remove(record);removed.push(record.snapshotId);}catch(error){if(error.code!==ErrorCode.CONFLICT)throw error;retained.push(record.snapshotId);}
      }
      const removedOrphans=[];
      if(removeOrphans)await context.enqueue(async()=>{await checkOwned();for(const name of [...orphans]){if(!temporaryName.test(name)&&!(recordName.test(name)&&name.endsWith('.bin')&&!sizes.has(name.slice(0,-4)+'.json')))continue;await removeFile(name);removedOrphans.push(name);}});
      return Object.freeze({removed:Object.freeze(removed),retained:Object.freeze(retained),removedOrphans:Object.freeze(removedOrphans),bytes:usedBytes});
    },
    inspect(){
      assertOpen();return Object.freeze({identity,files:new Set([...records.keys(),...problems.keys()]).size,bytes:usedBytes,limits,activeReaders,expired:Object.freeze([...records.values()].filter(r=>r.expiresAt<=Date.now()).map(r=>r.snapshotId)),problems:Object.freeze([...problems].map(([snapshotId,disposition])=>Object.freeze({snapshotId,disposition}))),orphanCount:orphans.size,records:Object.freeze([...records.values()])});
    },
    close(){if(closePromise)return closePromise;closing=true;closePromise=(async()=>{await Promise.allSettled([...operations]);closed=true;openedStores.delete(jobStore);})();return closePromise;},
  });
  return store;
}
