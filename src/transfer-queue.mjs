import {TRANSFER_QUEUE_LIMITS,parseTransferQueueOptions,parseTransferSnapshot,queueInteger} from './transfer-queue-contracts.mjs';
import {runUploadFile} from './upload-transfer.mjs';
import {runJobBinaryArtifact,runStoredJobArtifact,parseArtifactTransferReceipt} from './artifact-transfer-core.mjs';
import {parseUploadStatus,parseUploadSpec,EMPTY_UPLOAD_SHA256} from './uploads.mjs';
import {parseBinaryArtifactReference} from './artifacts.mjs';
import {parseStoredArtifactReference} from './artifact-storage.mjs';
import {isTransferTransient} from './transfer-transient.mjs';
import {exactObject,requireUuid,workspaceFailure,WORKSPACE_ERROR_CODES} from './workspace-values.mjs';
export {TRANSFER_QUEUE_LIMITS,TRANSFER_DEFAULTS,TRANSFER_STATES,TRANSFER_PHASES,parseTransferQueueOptions,parseTransferSnapshot} from './transfer-queue-contracts.mjs';

const terminal=state=>['completed','failed','cancelled'].includes(state);
const invoke=(callback,value)=>{const result=callback?.(value);if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw workspaceFailure('invalid_request','Progress callbacks must be synchronous');}};

/** A bounded caller-owned queue. Each supported transfer yields after one chunk. */
export function createTransferQueue(configuration={}){
  const limits=parseTransferQueueOptions(configuration),capacity=Math.min(limits.concurrency,limits.bufferBytes/65_536);
  const jobs=new Map(),connections=new WeakMap(),listeners=new Set();
  let closed=false,disposal,active=0,peakActive=0,sequence=0,ticket=0,wake,scheduled=false,listenerErrors=0,tokens=65_536,tokenTime=performance.now();
  const snapshot=job=>parseTransferSnapshot(job.view);
  function emit(job){job.view.sequence=++sequence;const value=snapshot(job);for(const listener of [...listeners])try{invoke(listener,value);}catch{listenerErrors++;}}
  function schedule(){if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;pump();});}}
  function removePending(job,error){const p=job.pending;if(p){job.pending=null;p.signal.removeEventListener('abort',p.abort);p.reject(error);}schedule();}
  function stage(job,run,metadata,signal){
    if(job.controller.signal.aborted||signal.aborted)return Promise.reject(job.controller.signal.reason??signal.reason);
    if(job.pending||job.view.active)return Promise.reject(workspaceFailure('conflict','A transfer already has a pending stage'));
    return new Promise((resolve,reject)=>{
      const pending={run,metadata,signal,resolve,reject,attempt:0,ticket:++ticket,notBefore:0};
      pending.abort=()=>removePending(job,signal.reason??workspaceFailure('cancelled','Transfer cancelled'));
      job.pending=pending;signal.addEventListener('abort',pending.abort,{once:true});schedule();
    });
  }
  function pump(){
    clearTimeout(wake);wake=undefined;let nextWake=Infinity;
    const now=performance.now();if(limits.bytesPerSecond){tokens=Math.min(65_536,tokens+(now-tokenTime)*limits.bytesPerSecond/1_000);}tokenTime=now;
    while(active<capacity){
      const candidates=[...jobs.values()].filter(j=>j.pending&&!j.view.pauseRequested&&!j.view.active&&!terminal(j.view.state)&&j.connection.active<limits.perConnection&&(!j.pending.metadata.uploadSlots||j.uploadLease||j.connection.uploads<j.pending.metadata.uploadSlots));
      for(const j of candidates)if(j.pending.notBefore>now)nextWake=Math.min(nextWake,j.pending.notBefore-now);
      // Priority is a bounded head start of 0..3 tickets; older work always ages past it.
      const ready=candidates.filter(j=>j.pending.notBefore<=now).sort((a,b)=>(a.pending.ticket-a.view.priority)-(b.pending.ticket-b.view.priority)||a.pending.ticket-b.pending.ticket);
      if(!ready.length)break;
      let job=ready[0];
      const bytes=job.pending.metadata.bytes??0;
      if(limits.bytesPerSecond&&bytes>tokens){
        nextWake=Math.min(nextWake,(bytes-tokens)*1_000/limits.bytesPerSecond);
        // Local hashing/verification consumes no network tokens and can still make progress.
        job=ready.find(j=>(j.pending.metadata.bytes??0)===0);if(!job)break;
      }
      const pending=job.pending,charged=pending.metadata.bytes??0;job.pending=null;pending.signal.removeEventListener('abort',pending.abort);
      if(pending.metadata.uploadSlots&&!job.uploadLease){job.uploadLease=true;job.connection.uploads++;}
      if(limits.bytesPerSecond)tokens-=charged;active++;job.connection.active++;peakActive=Math.max(peakActive,active);job.view.active=true;job.view.state='running';job.view.phase=pending.metadata.phase??job.view.phase;
      if(job.view.phase==='committing')job.view.commit='unknown';
      job.view.attemptedBytes+=charged;if(pending.attempt)job.view.retriedBytes+=charged;pending.attempt++;emit(job);
      void execute(job,pending);
    }
    if(Number.isFinite(nextWake)&&!closed)wake=setTimeout(schedule,Math.max(1,Math.ceil(nextWake)));
  }
  async function execute(job,p){
    let value,error,failed=false,retry=false;
    try{if(p.signal.aborted)throw p.signal.reason;value=await p.run();}
    catch(failure){failed=true;error=failure;retry=!p.signal.aborted&&!job.controller.signal.aborted&&p.metadata.canRetry?.(failure)===true&&isTransferTransient(failure)&&p.attempt<limits.attempts;}
    active--;job.connection.active--;job.view.active=false;
    if(retry){
      job.view.retries++;const exponential=Math.min(limits.maxDelayMs,limits.baseDelayMs*2**(p.attempt-1));
      p.notBefore=performance.now()+exponential*(0.5+Math.random()*0.5);p.ticket=++ticket;job.pending=p;p.signal.addEventListener('abort',p.abort,{once:true});
    }
    if(job.view.pauseRequested)job.view.state='paused';emit(job);
    if(!retry){if(failed)p.reject(error);else p.resolve(value);}schedule();
  }
  function lookup(id){requireUuid(id);const job=jobs.get(id);if(!job)throw workspaceFailure('not_found','Transfer is not in this queue');return job;}
  function change(id,action){
    const job=lookup(id);if(terminal(job.view.state))return snapshot(job);
    if(action==='cancel'&&job.controller.signal.aborted||action!=='cancel'&&job.view.pauseRequested===(action==='pause'))return snapshot(job);
    if(action==='cancel'){
      job.view.pauseRequested=false;if(job.view.state==='paused')job.view.state='running';
      job.controller.abort(workspaceFailure('cancelled','Transfer cancelled'));removePending(job,job.controller.signal.reason);
    }else{
      job.view.pauseRequested=action==='pause';if(!job.view.active)job.view.state=job.view.pauseRequested?'paused':'queued';
    }
    emit(job);schedule();return snapshot(job);
  }
  function add(kind,client,input,options,scheduling={}){
    if(closed)throw workspaceFailure('disposed','Transfer queue is disposed');if(jobs.size>=limits.maxTransfers)throw workspaceFailure('budget_exceeded','Release a terminal transfer before adding another');
    exactObject(scheduling,[],['id','priority']);const id=scheduling.id??globalThis.crypto.randomUUID(),priority=scheduling.priority??0;requireUuid(id);queueInteger(priority,3);if(jobs.has(id))throw workspaceFailure('conflict','Transfer id already exists');
    if(!client?.binding)throw workspaceFailure('unavailable','Connect before enqueueing a transfer');
    let totalBytes,reference;
    if(kind==='upload'){
      exactObject(options,['uploadId','pluginId','artifactSha256','path','expectedRevision'],['recover','signal','timeoutMs','requestTimeoutMs','onProgress']);
      if(!input||typeof input.read!=='function')throw workspaceFailure('invalid_request','Select an upload source');totalBytes=queueInteger(input.byteLength,1_073_741_824);
      parseUploadSpec({uploadId:options.uploadId,pluginId:options.pluginId,artifactSha256:options.artifactSha256,path:options.path,expectedRevision:options.expectedRevision,byteLength:totalBytes,sha256:EMPTY_UPLOAD_SHA256});
    }else{
      exactObject(options,['sink'],['signal','timeoutMs','requestTimeoutMs','onProgress']);
      reference=kind==='download'?parseBinaryArtifactReference(input):parseStoredArtifactReference(input);totalBytes=kind==='download'?reference.artifact.byteLength:reference.snapshot.artifact.byteLength;
    }
    if(options.signal!==undefined&&!(options.signal instanceof AbortSignal)||options.onProgress!==undefined&&typeof options.onProgress!=='function')throw workspaceFailure('invalid_request','Invalid transfer callbacks');
    options={...options};
    let connection=connections.get(client);if(!connection||connection.binding!==client.binding){connection={id:globalThis.crypto.randomUUID(),binding:client.binding,active:0,uploads:0};connections.set(client,connection);}
    const controller=new AbortController(),externalAbort=()=>controller.abort(workspaceFailure('cancelled','Transfer cancelled'));
    if(options.signal?.aborted)externalAbort();else options.signal?.addEventListener('abort',externalAbort,{once:true});
    const job={connection,controller,pending:null,prefixKnown:false,view:{protocolVersion:1,id,connectionId:connection.id,sequence:0,kind,state:'queued',phase:'queued',priority,active:false,pauseRequested:false,totalBytes,acknowledgedBytes:0,transferredBytes:0,attemptedBytes:0,retriedBytes:0,resumedBytes:0,remainingBytes:totalBytes,retries:0,verified:false,verification:'pending',commit:'not-committed',partialDisposition:'unknown',error:null}};
    jobs.set(id,job);
    function progress(p){
      if(kind==='upload'){
        if(p.status&&!job.prefixKnown){job.view.resumedBytes=p.status.offset;job.prefixKnown=true;}
        if(p.status){job.view.acknowledgedBytes=p.status.offset;job.view.transferredBytes=p.status.offset-job.view.resumedBytes;job.view.partialDisposition='retained';}
        if(p.phase==='committed')job.view.commit='committed';
      }else{job.view.acknowledgedBytes=p.writtenBytes;job.view.transferredBytes=p.writtenBytes;if(['verifying-storage','completed'].includes(p.phase))job.view.commit='committed';}
      job.view.remainingBytes=totalBytes-job.view.acknowledgedBytes;
      if(p.phase!=='completed'&&p.phase!=='committed')job.view.phase=p.phase;
      emit(job);invoke(options.onProgress,p);
    }
    const control={step:(run,metadata,signal)=>stage(job,run,metadata,signal)};
    const run=kind==='upload'?runUploadFile:kind==='download'?runJobBinaryArtifact:runStoredJobArtifact;
    job.result=run(client,reference??input,{...options,signal:controller.signal,onProgress:progress},control).then(result=>{
      const receipt=kind==='upload'?parseUploadStatus(result):parseArtifactTransferReceipt(result);
      if(kind==='upload'&&(receipt.state!=='committed'||receipt.commitReceipt?.verified!==true))throw workspaceFailure('conflict','Upload did not produce a verified commit');
      job.view.state='completed';job.view.phase='completed';job.view.verified=true;job.view.verification=kind==='upload'?'upload-commit':receipt.verification;job.view.commit='committed';job.view.partialDisposition='retained';return receipt;
    }).catch(error=>{
      job.view.state=error?.code==='cancelled'||controller.signal.aborted?'cancelled':'failed';
      job.view.error={code:WORKSPACE_ERROR_CODES.includes(error?.code)?error.code:'unavailable',message:String(error?.message??'Transfer failed').slice(0,2_048).toWellFormed()};
      if(error?.partial){job.view.commit=error.partial.commit;job.view.partialDisposition=error.partial.disposition;}throw error;
    }).finally(()=>{job.view.active=false;job.view.pauseRequested=false;if(job.uploadLease)job.connection.uploads--;options.signal?.removeEventListener('abort',externalAbort);emit(job);schedule();});
    // A UI may subscribe before choosing to await; retain rejection on the original result.
    job.result.catch(()=>{});
    emit(job);
    const boundChange=action=>{if(jobs.get(id)!==job)throw workspaceFailure('disposed','Transfer handle was released');return change(id,action);};
    return Object.freeze({id,result:job.result,get snapshot(){return snapshot(job);},pause:()=>boundChange('pause'),resume:()=>boundChange('resume'),cancel:()=>boundChange('cancel')});
  }
  return Object.freeze({limits,
    enqueueUpload:(client,source,options,scheduling)=>add('upload',client,source,options,scheduling),
    enqueueDownload:(client,reference,options,scheduling)=>add('download',client,reference,options,scheduling),
    enqueueStoredDownload:(client,reference,options,scheduling)=>add('stored-download',client,reference,options,scheduling),
    get:id=>snapshot(lookup(id)),list:()=>Object.freeze([...jobs.values()].map(snapshot)),
    pause:id=>change(id,'pause'),resume:id=>change(id,'resume'),cancel:id=>change(id,'cancel'),
    release(id){const job=lookup(id);if(!terminal(job.view.state))throw workspaceFailure('conflict','Only terminal transfers can be released');jobs.delete(id);return true;},
    subscribe(listener){if(closed)throw workspaceFailure('disposed','Transfer queue is disposed');if(typeof listener!=='function')throw workspaceFailure('invalid_request','Expected a listener');if(listeners.size>=TRANSFER_QUEUE_LIMITS.listeners)throw workspaceFailure('budget_exceeded','Listener limit exceeded');listeners.add(listener);return()=>listeners.delete(listener);},
    inspect(){return Object.freeze({transfers:jobs.size,active,peakActive,peakChunkBytes:peakActive*65_536,pending:[...jobs.values()].filter(j=>j.pending).length,listeners:listeners.size,listenerErrors,disposed:closed});},
    dispose(){if(disposal)return disposal;let settled;disposal=new Promise(resolve=>{settled=resolve;});closed=true;clearTimeout(wake);for(const job of jobs.values())if(!terminal(job.view.state))change(job.view.id,'cancel');void Promise.allSettled([...jobs.values()].map(j=>j.result)).then(()=>{listeners.clear();clearTimeout(wake);settled();});return disposal;},
  });
}
