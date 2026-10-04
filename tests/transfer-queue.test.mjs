import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createTransferQueue,parseTransferSnapshot,parseTransferQueueOptions} from '../src/transfer-queue.mjs';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';
import {definePlugin} from '../src/index.mjs';
import {createBrowserUploadSource} from '../src/uploads-browser.mjs';
import {BINARY_ARTIFACT_LIMITS} from '../src/artifacts.mjs';
import {workspaceFailure} from '../src/workspace-values.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),pin='a'.repeat(64),token='transfer-queue-test-token-0123456789';
const data=length=>Buffer.alloc(length,0xba);
const selected=()=>({uploadId:randomUUID(),pluginId:'queue-test',artifactSha256:pin,path:`input/${randomUUID()}.bin`,expectedRevision:null});
const source=bytes=>createBrowserUploadSource(new File([bytes],'selected.bin'));
async function until(predicate){const deadline=Date.now()+5_000;while(!predicate()){if(Date.now()>deadline)throw Error('condition timeout');await delay(5);}}
function sink({slow=0,writeHook,commitHook,readHook}={}){
  const state={bytes:Buffer.alloc(0),committed:false,aborts:0,active:0,peak:0};
  return{state,capabilities:{kind:'caller',seek:false,readback:true,persistence:'on-commit',abort:'discard'},async open(){return{
    async write({offset,bytes,signal}){state.active++;state.peak=Math.max(state.peak,state.active);try{await writeHook?.({offset,bytes,signal});if(slow)await delay(slow,undefined,{signal});assert.equal(offset,state.bytes.length);state.bytes=Buffer.concat([state.bytes,bytes]);}finally{state.active--; }},
    async commit(options){await commitHook?.(options);state.committed=true;},async abort(){state.aborts++;if(!state.committed)state.bytes=Buffer.alloc(0);},
    async readback(){return{byteLength:state.bytes.length,async read(offset,length){await readHook?.();return state.bytes.subarray(offset,offset+length);}};},
  };}};
}
function binary(length=524_305,client){
  const bytes=data(length),scope=client?{projectId:client.binding.workspace.id,sessionId:client.binding.workspace.generation}:{projectId:randomUUID(),sessionId:randomUUID()};
  const reference={scope,jobId:randomUUID(),artifact:{id:'binary',path:'seed.bin',byteLength:length,revision:digest(bytes)}};
  const own=client??{binding:{workspace:{id:scope.projectId,generation:scope.sessionId}},async getBinaryArtifactCapabilities(){return{protocolVersion:1,enabled:true,limits:BINARY_ARTIFACT_LIMITS};}};
  const refs=own.refs??new Map();own.refs=refs;refs.set(reference.jobId,{reference,bytes});
  own.getJobBinaryArtifact=async id=>refs.get(id).reference;
  own.readJobBinaryArtifactChunk=async(ref,offset,{length})=>{const selected=refs.get(ref.jobId),part=selected.bytes.subarray(offset,offset+length);return{...selected.reference,offset,nextOffset:offset+part.length,eof:offset+part.length===selected.bytes.length,data:part.toString('base64'),sha256:digest(part)};};
  return{client:own,reference,bytes};
}
async function fixture(t,{length=196_625,transport}={}){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-transfer-queue-'))),root=path.join(directory,'workspace');await fs.mkdir(path.join(root,'input'),{recursive:true});const bytes=data(length);await fs.writeFile(path.join(root,'seed.bin'),bytes);
  const plugin=definePlugin({manifestVersion:2,id:'queue-test',name:'Queue test',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','workspace.write'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}},ctx=>ctx.registerCommand({id:'collect',title:'Collect'},async(_,{job})=>{await job.addBinaryArtifact({id:'binary',path:'seed.bin'});return{};}));
  const server=await createWorkspaceServer({root,workspaceId:randomUUID(),token,notice:{id:'test',version:'1',text:'Queue tests'},plugins:[{plugin,artifactSha256:pin}],grants:['workspace.read','workspace.write'],jobs:true,binaryArtifacts:true,uploads:{directory:path.join(directory,'uploads'),principalId:'operator',roots:['input'],fileSystem:'local'},timeoutMs:30_000});
  const calls=[];const client=createWorkspaceClient({url:server.url,token,fetch:async(url,options)=>{const request=JSON.parse(options.body);calls.push(request);return transport?transport(request,()=>fetch(url,options),options):fetch(url,options);}});await client.connect();
  const job=await client.startCommandJob('queue-test','collect',{},pin,{jobId:randomUUID()});await client.waitForJob(job.jobId,{intervalMs:250});const reference=await client.getJobBinaryArtifact(job.jobId,'binary');
  t.after(async()=>{client.dispose();await server.close();assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir()));assert.ok(path.basename(directory).startsWith('dds-transfer-queue-'));await fs.rm(directory,{recursive:true});});return{client,reference,bytes,calls,root,server};
}

test('queue shares upload/download verifiers, pauses at chunk boundaries and resumes in memory',async t=>{
  const f=await fixture(t),queue=createTransferQueue({concurrency:2}),out=sink({slow:5}),events=[];t.after(()=>queue.dispose());queue.subscribe(s=>events.push(s));let upload;
  let paused=false;upload=queue.enqueueUpload(f.client,source(f.bytes),selected(),{priority:1});queue.subscribe(s=>{if(!paused&&s.id===upload.id&&s.phase==='uploading'&&s.acknowledgedBytes===65536){paused=true;upload.pause();}});
  const download=queue.enqueueDownload(f.client,f.reference,{sink:out});await until(()=>upload.snapshot.state==='paused');const count=f.calls.filter(r=>r.method==='uploads.write').length;
  await download.result;assert.equal(upload.snapshot.acknowledgedBytes,65536);assert.equal(f.calls.filter(r=>r.method==='uploads.write').length,count);assert.equal(download.snapshot.verification,'stored');assert.equal(digest(out.state.bytes),digest(f.bytes));
  upload.resume();await upload.result;assert.equal(upload.snapshot.state,'completed');assert.equal(upload.snapshot.resumedBytes,0);assert.equal(upload.snapshot.transferredBytes,f.bytes.length);assert.equal(upload.snapshot.attemptedBytes,f.bytes.length);
  assert.ok(events.some(s=>s.remainingBytes===0&&!s.verified));assert.ok(events.every(s=>parseTransferSnapshot(s)));assert.ok(queue.inspect().peakActive<=2);assert.equal(out.state.peak,1);
});

test('round robin schedules small files and bounded priority past more than four large transfers',async()=>{
  const q=createTransferQueue({concurrency:1,perConnection:1}),large=binary(1_048_593),handles=[],order=[];
  try{for(let n=0;n<6;n++){const x=n?binary(1_048_593,large.client):large;const h=q.enqueueDownload(x.client,x.reference,{sink:sink()},{priority:3});handles.push(h);h.result.then(()=>order.push('large'));}
    const small=binary(17,large.client),h=q.enqueueDownload(small.client,small.reference,{sink:sink()});handles.push(h);h.result.then(()=>order.push('small'));await Promise.all(handles.map(h=>h.result));
    assert.equal(order[0],'small');assert.equal(q.inspect().peakActive,1);assert.equal(q.inspect().peakChunkBytes,65536);assert.equal(q.inspect().pending,0);
  }finally{await q.dispose();}
});

test('saturated connections do not block another connection and memory admission reduces concurrency',async()=>{
  const q=createTransferQueue({concurrency:4,perConnection:1,bufferBytes:131072}),one=binary(),two=binary();let unblock,blocked;
  const waiting=new Promise(resolve=>{blocked=resolve;}),gate=new Promise(resolve=>{unblock=resolve;});
  const first=q.enqueueDownload(one.client,one.reference,{sink:sink({writeHook:async()=>{blocked();await gate;}})});await waiting;
  const same=q.enqueueDownload(one.client,one.reference,{sink:sink()}),other=q.enqueueDownload(two.client,two.reference,{sink:sink()});await other.result;
  assert.equal(first.snapshot.state,'running');assert.equal(same.snapshot.acknowledgedBytes,0);assert.equal(other.snapshot.verified,true);unblock();await Promise.all([first.result,same.result]);assert.ok(q.inspect().peakActive<=2);await q.dispose();
});

test('only classified 429/503/network/timeout chunk failures retry, with duplicate upload acknowledgement',async t=>{
  let uploadAttempts=0,readAttempts=0;
  const f=await fixture(t,{transport:async(r,next,options)=>{
    if(r.method==='uploads.write'){uploadAttempts++;if(uploadAttempts===1){const response=await next();await response.json();throw Error('lost acknowledgement');}if(uploadAttempts===2)return new Response('',{status:503});}
    if(r.method==='artifacts.read'){readAttempts++;if(readAttempts===1)return new Response('',{status:429});if(readAttempts===2)return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Error('request timeout')),{once:true}));}
    return next();
  }}),q=createTransferQueue({attempts:4,baseDelayMs:10,maxDelayMs:20});t.after(()=>q.dispose());
  const u=q.enqueueUpload(f.client,source(f.bytes),selected()),d=q.enqueueDownload(f.client,f.reference,{sink:sink(),requestTimeoutMs:500});await Promise.all([u.result,d.result]);
  for(const h of [u,d]){assert.equal(h.snapshot.retries,2);assert.equal(h.snapshot.retriedBytes,131072);assert.equal(h.snapshot.attemptedBytes,f.bytes.length+131072);assert.equal(h.snapshot.transferredBytes,f.bytes.length);}
  const writes=f.calls.filter(r=>r.method==='uploads.write');assert.deepEqual(writes[0].params,writes[1].params);assert.deepEqual(writes[1].params,writes[2].params);
});

test('retry backoff releases capacity, retries are bounded, and policy/validation failures never retry',async t=>{
  let attempts=0;
  const f=await fixture(t,{transport:async(r,next)=>{if(r.method==='artifacts.read'){attempts++;return new Response('',{status:503});}return next();}}),q=createTransferQueue({concurrency:1,attempts:3,baseDelayMs:100,maxDelayMs:100});t.after(()=>q.dispose());
  const a=q.enqueueDownload(f.client,f.reference,{sink:sink()});await until(()=>a.snapshot.retries===1);const fast=binary(1),b=q.enqueueDownload(fast.client,fast.reference,{sink:sink()});await b.result;assert.equal(a.snapshot.verified,false);await assert.rejects(a.result,{code:'transport_failed'});assert.equal(attempts,3);
  for(const code of ['authentication_required','permission_denied','conflict','invalid_request','budget_exceeded','generation_mismatch']){
    const x=binary(7);let reads=0;x.client.readJobBinaryArtifactChunk=async()=>{reads++;throw workspaceFailure(code,'not transient');};const h=q.enqueueDownload(x.client,x.reference,{sink:sink()});await assert.rejects(h.result,{code});assert.equal(reads,1);assert.equal(h.snapshot.retries,0);
  }
});

test('cancel/dispose settles paused transfers and retains only the sink-specific partial outcome',async t=>{
  const f=await fixture(t),q=createTransferQueue(),out=sink();let u,d;
  u=q.enqueueUpload(f.client,source(f.bytes),selected());d=q.enqueueDownload(f.client,f.reference,{sink:out});q.subscribe(s=>{if(s.acknowledgedBytes===65536&&!s.pauseRequested){if(s.id===u.id)u.pause();if(s.id===d.id)d.pause();}});
  await until(()=>u.snapshot.state==='paused'&&d.snapshot.state==='paused');await q.dispose();await assert.rejects(u.result,{code:'cancelled'});await assert.rejects(d.result,{code:'cancelled'});
  assert.equal(u.snapshot.partialDisposition,'retained');assert.equal(d.snapshot.partialDisposition,'discarded');assert.equal(out.state.bytes.length,0);assert.equal(q.inspect().pending,0);assert.equal(q.inspect().active,0);assert.equal(q.inspect().listeners,0);
});

test('queued and paused time counts toward the overall deadline; no automatic reconnect',async()=>{
  const x=binary(),q=createTransferQueue();const h=q.enqueueDownload(x.client,x.reference,{sink:sink(),timeoutMs:50});h.pause();await assert.rejects(h.result,{code:'budget_exceeded'});assert.equal(h.snapshot.state,'failed');
  const changed=q.enqueueDownload(x.client,x.reference,{sink:sink()});changed.pause();x.client.binding={...x.client.binding};changed.resume();await assert.rejects(changed.result,{code:'disposed'});assert.equal(changed.snapshot.retries,0);await q.dispose();
});

test('lost commit response is never replayed; explicit recovery reports the committed prefix',async t=>{
  let commits=0;const f=await fixture(t,{transport:async(r,next)=>{const response=await next();if(r.method==='uploads.commit'&&++commits===1){await response.json();throw Error('lost commit response');}return response;}}),q=createTransferQueue(),target=selected();t.after(()=>q.dispose());
  const first=q.enqueueUpload(f.client,source(f.bytes),target);await assert.rejects(first.result,{code:'transport_failed'});assert.equal(first.snapshot.commit,'unknown');assert.equal(first.snapshot.verified,false);assert.equal(first.snapshot.retries,0);assert.equal(commits,1);
  const resumed=q.enqueueUpload(f.client,source(f.bytes),{...target,recover:true});await resumed.result;assert.equal(resumed.snapshot.resumedBytes,f.bytes.length);assert.equal(resumed.snapshot.transferredBytes,0);assert.equal(resumed.snapshot.attemptedBytes,0);assert.equal(commits,1);
});

test('rate budget covers retries and buffers stay bounded under a slow sink',async()=>{
  const x=binary(131072),q=createTransferQueue({concurrency:4,bufferBytes:65536,bytesPerSecond:131072}),started=performance.now(),out=sink({slow:10});
  const h=q.enqueueDownload(x.client,x.reference,{sink:out});await h.result;assert.ok(performance.now()-started>=430);assert.equal(q.inspect().peakChunkBytes,65536);assert.equal(out.state.peak,1);await q.dispose();
});

test('strict contracts, finite retention and listeners; released handles cannot control reused ids',async()=>{
  assert.throws(()=>parseTransferQueueOptions({concurrency:5}),{code:'invalid_request'});assert.throws(()=>parseTransferQueueOptions({bufferBytes:65537}),{code:'invalid_request'});assert.throws(()=>parseTransferQueueOptions({get concurrency(){throw Error('getter');}}),{code:'invalid_request'});
  const x=binary(0),q=createTransferQueue({maxTransfers:1}),id=randomUUID(),h=q.enqueueDownload(x.client,x.reference,{sink:sink()},{id});h.pause();assert.throws(()=>q.enqueueDownload(x.client,x.reference,{sink:sink()}),{code:'budget_exceeded'});assert.throws(()=>q.release(id),{code:'conflict'});
  const unsub=[];for(let n=0;n<16;n++)unsub.push(q.subscribe(()=>{}));assert.throws(()=>q.subscribe(()=>{}),{code:'budget_exceeded'});unsub.forEach(f=>f());q.subscribe(()=>{throw Error('UI bug');});h.resume();await h.result;assert.ok(q.inspect().listenerErrors>0);
  assert.throws(()=>parseTransferSnapshot({...h.snapshot,verified:false}),{code:'invalid_request'});q.release(id);const replacement=q.enqueueDownload(x.client,x.reference,{sink:sink()},{id});assert.throws(()=>h.cancel(),{code:'disposed'});await replacement.result;await q.dispose();assert.throws(()=>q.enqueueDownload(x.client,x.reference,{sink:sink()}),{code:'disposed'});
});

test('more uploads than host session slots wait instead of exhausting the host active budget',async t=>{
  const f=await fixture(t),q=createTransferQueue(),bytes=data(65553);t.after(()=>q.dispose());
  const uploads=Array.from({length:7},()=>q.enqueueUpload(f.client,source(bytes),selected()));
  await Promise.all(uploads.map(h=>h.result));assert.ok(uploads.every(h=>h.snapshot.verified));assert.equal(f.calls.filter(r=>r.method==='uploads.begin').length,7);
});

test('changed source on retry is rejected before another write and sink errors cannot reuse a network retry marker',async t=>{
  let mutable=data(65553),writes=0,readFailure,failRead=false;
  const f=await fixture(t,{transport:async(r,next)=>{
    if(r.method==='uploads.write'&&++writes===1){const response=await next();await response.json();mutable=Buffer.alloc(mutable.length,0x42);throw Error('lost write response');}
    if(failRead&&r.method==='artifacts.read')return new Response('',{status:503});return next();
  }}),q=createTransferQueue({baseDelayMs:10,maxDelayMs:10});t.after(()=>q.dispose());
  const input={byteLength:mutable.length,async read(offset,length){return mutable.subarray(offset,offset+length);}},upload=q.enqueueUpload(f.client,input,selected());
  await assert.rejects(upload.result,{code:'conflict'});assert.equal(writes,1);assert.equal(upload.snapshot.verified,false);
  failRead=true;try{await f.client.readJobBinaryArtifactChunk(f.reference,0,{length:65536});}catch(error){readFailure=error;}failRead=false;
  const before=f.calls.filter(r=>r.method==='artifacts.read').length,download=q.enqueueDownload(f.client,f.reference,{sink:sink({writeHook:()=>{throw readFailure;}})});await assert.rejects(download.result,{code:'transport_failed'});
  assert.equal(f.calls.filter(r=>r.method==='artifacts.read').length-before,1);assert.equal(download.snapshot.retries,0);
});

test('explicit recovery verifies a saved prefix and reports it separately from new transfer bytes',async t=>{
  const f=await fixture(t),q=createTransferQueue(),target=selected();t.after(()=>q.dispose());let first;
  first=q.enqueueUpload(f.client,source(f.bytes),target);const stop=q.subscribe(s=>{if(s.id===first.id&&s.acknowledgedBytes===65536&&!first.snapshot.error)first.cancel();});
  await assert.rejects(first.result,{code:'cancelled'});stop();const next=q.enqueueUpload(f.client,source(f.bytes),{...target,recover:true});await next.result;
  assert.equal(next.snapshot.resumedBytes,65536);assert.equal(next.snapshot.transferredBytes,f.bytes.length-65536);assert.equal(next.snapshot.attemptedBytes,f.bytes.length-65536);
});

test('reentrant disposal from the initial event waits for all transfer cleanup',async()=>{
  const x=binary(),q=createTransferQueue();let disposed;q.subscribe(()=>{disposed=q.dispose();});const h=q.enqueueDownload(x.client,x.reference,{sink:sink()});await disposed;await assert.rejects(h.result,{code:'cancelled'});assert.equal(q.inspect().active,0);assert.equal(q.inspect().pending,0);
});

test('100 percent received is still unverified when whole-file or committed-storage verification fails',async()=>{
  const q=createTransferQueue();try{
    const broken=binary(65553);broken.reference.artifact.revision='b'.repeat(64);const first=q.enqueueDownload(broken.client,broken.reference,{sink:sink()});
    await assert.rejects(first.result,{code:'conflict'});assert.equal(first.snapshot.remainingBytes,0);assert.equal(first.snapshot.verified,false);assert.equal(first.snapshot.commit,'not-committed');
    const valid=binary(65553),out=sink({readHook:()=>{out.state.bytes[0]^=1;}}),second=q.enqueueDownload(valid.client,valid.reference,{sink:out});
    await assert.rejects(second.result,{code:'conflict'});assert.equal(second.snapshot.remainingBytes,0);assert.equal(second.snapshot.verified,false);assert.equal(second.snapshot.commit,'committed');assert.equal(second.snapshot.partialDisposition,'retained');
  }finally{await q.dispose();}
});

test('retry payload consumes the shared rate bucket again',async t=>{
  let rejected=false;const f=await fixture(t,{length:65536,transport:async(r,next)=>{if(r.method==='artifacts.read'&&!rejected){rejected=true;return new Response('',{status:503});}return next();}}),q=createTransferQueue({bytesPerSecond:131072,baseDelayMs:1,maxDelayMs:1});t.after(()=>q.dispose());
  const started=performance.now(),h=q.enqueueDownload(f.client,f.reference,{sink:sink()});await h.result;assert.equal(h.snapshot.attemptedBytes,131072);assert.equal(h.snapshot.retriedBytes,65536);assert.ok(performance.now()-started>=430);
});

test('caller rejection with undefined settles as failure and progress options are captured at admission',async()=>{
  const x=binary(17),q=createTransferQueue(),first=q.enqueueDownload(x.client,x.reference,{sink:sink({writeHook:()=>{throw undefined;}})});await assert.rejects(first.result,{code:'unavailable'});assert.equal(first.snapshot.state,'failed');
  const options={sink:sink(),onProgress:()=>{}},second=q.enqueueDownload(x.client,x.reference,options);options.onProgress=()=>{throw Error('changed after admission');};await second.result;assert.equal(second.snapshot.verified,true);await q.dispose();
});
