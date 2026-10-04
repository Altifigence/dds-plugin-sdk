import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createOpfsArtifactSink,getOpfsArtifactPartialNames,getBrowserArtifactResumeSupport,parseBrowserArtifactCheckpoint} from '../src/artifact-resume-browser.mjs';
import {streamStoredJobArtifact} from '../src/artifact-transfer.mjs';
import {createIncrementalSha256,snapshotSha256} from '../src/sha256-stream.mjs';
import {createTransferQueue} from '../src/transfer-queue.mjs';
import {ARTIFACT_STORE_LIMITS} from '../src/artifact-storage.mjs';
import {workspaceFailure} from '../src/workspace-values.mjs';
import {createResumeFixture} from '../examples/browser-resume/host.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(',')}]`:`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const code=expected=>error=>error.code===expected;
function fakeStorage(){
  const files=new Map(),held=new Set(),state={created:0,sync:0,maxRead:0,maxWrite:0,failMetadata:null,failData:null};
  function file(name){
    let entry=files.get(name);
    if(!entry){entry={bytes:Buffer.alloc(0),locked:false};files.set(name,entry);state.created++;}
    return {kind:'file',async getFile(){return new Blob([entry.bytes]);},async createWritable(){
      let buffer;return{async write(bytes){buffer=Buffer.from(bytes);},async close(){
        if(state.closeGate){const gate=state.closeGate;state.closeGate=null;gate.enter();await gate.wait;}
        const mode=state.failMetadata;state.failMetadata=null;
        if(mode==='before')throw new DOMException('Full','QuotaExceededError');
        entry.bytes=buffer;
        if(mode==='after')throw new DOMException('Close reply lost','UnknownError');
      },async abort(){}};
    },async createSyncAccessHandle(){
      if(entry.locked)throw new DOMException('Locked','NoModificationAllowedError');entry.locked=true;state.sync++;
      let closed=false;const current=()=>{if(closed)throw new DOMException('Closed','InvalidStateError');};
      return{getSize(){current();return entry.bytes.length;},read(bytes,{at}){current();state.maxRead=Math.max(state.maxRead,bytes.length);const part=entry.bytes.subarray(at,at+bytes.length);bytes.set(part);return part.length;},
        write(bytes,{at}){current();state.maxWrite=Math.max(state.maxWrite,bytes.length);const mode=state.failData;state.failData=null;const count=mode==='short'?Math.floor(bytes.length/2):bytes.length;
          if(at+count>entry.bytes.length){const extended=Buffer.alloc(at+count);entry.bytes.copy(extended);entry.bytes=extended;}entry.bytes.set(bytes.subarray(0,count),at);return count;},
        truncate(size){current();entry.bytes=Buffer.from(entry.bytes.subarray(0,size));},flush(){current();},close(){closed=true;entry.locked=false;},
      };
    }};
  }
  const directory={kind:'directory',async getFileHandle(name,{create=false}={}){if(!files.has(name)&&!create)throw new DOMException('Missing','NotFoundError');return file(name);}};
  const locks={async request(name,options,callback){assert.deepEqual(options,{mode:'exclusive',ifAvailable:true});if(held.has(name))return callback(null);held.add(name);try{return await callback({name});}finally{held.delete(name);}}};
  return {directory,locks,files,held,state};
}
function fixture(length=196_625){
  const storage=fakeStorage(),bytes=randomBytes(length),now=Date.now(),projectId=randomUUID(),jobId=randomUUID();
  let reference={protocolVersion:1,storage:'snapshot',scope:{projectId,sessionId:randomUUID()},snapshot:{schemaVersion:1,storeId:randomUUID(),workspaceId:projectId,workspaceIdentity:'d'.repeat(64),snapshotId:randomUUID(),jobId,pluginId:'example',pluginArtifactSha256:'a'.repeat(64),kind:'binary',artifact:{id:'binary',path:'out/result.bin',revision:digest(bytes),byteLength:length},capturedAt:now,expiresAt:now+3_600_000}};
  const reads=[],partialId=randomUUID(),names=getOpfsArtifactPartialNames(partialId);let allowed=true;
  const client={binding:{workspace:{id:projectId,generation:reference.scope.sessionId}},async getArtifactStorageCapabilities(){return{protocolVersion:1,enabled:true,identity:{schemaVersion:1,storeId:reference.snapshot.storeId,workspaceId:projectId,workspaceIdentity:reference.snapshot.workspaceIdentity},limits:ARTIFACT_STORE_LIMITS};},async getStoredJobArtifact(){if(!allowed)throw workspaceFailure('permission_denied','Denied');return reference;},async readStoredJobArtifactChunk(_ref,offset,{length}){if(!allowed)throw workspaceFailure('permission_denied','Denied');reads.push(offset);const part=bytes.subarray(offset,offset+length);return{reference,offset,nextOffset:offset+part.length,eof:offset+part.length===bytes.length,data:part.toString('base64'),sha256:digest(part)};}};
  const sink=(extra={})=>createOpfsArtifactSink({directory:storage.directory,locks:storage.locks,partialId,reference,...extra});
  const metadata=()=>JSON.parse(storage.files.get(names.metadata).bytes.toString());
  const rewrite=mutate=>{const value=metadata();mutate(value);delete value.checksum;value.checksum=digest(canonical(value));storage.files.get(names.metadata).bytes=Buffer.from(JSON.stringify(value));};
  const partial=async(chunks=1)=>{const controller=new AbortController();await assert.rejects(streamStoredJobArtifact(client,reference,{sink:sink(),signal:controller.signal,onProgress:p=>{if(p.receivedBytes>=chunks*65536)controller.abort();}}),code('cancelled'));assert.equal(storage.held.size,0);};
  return {storage,bytes,client,reads,partialId,names,sink,metadata,rewrite,partial,get reference(){return reference;},rebind(){reference={...reference,scope:{...reference.scope,sessionId:randomUUID()}};client.binding={workspace:{id:projectId,generation:reference.scope.sessionId}};},deny(){allowed=false;},allow(){allowed=true;}};
}

test('checkpoint SHA snapshots are independent and preserve finalizing digest semantics',()=>{
  const bytes=randomBytes(131_073),hash=createIncrementalSha256();
  for(const end of [1,55,56,63,64,65,65536,131073]){hash.update(bytes.subarray(hash.byteLength,end));assert.equal(snapshotSha256(hash),digest(bytes.subarray(0,end)));assert.equal(snapshotSha256(hash),digest(bytes.subarray(0,end)));}
  assert.equal(hash.digest(),digest(bytes));assert.throws(()=>snapshotSha256(hash),code('disposed'));
});
test('checkpoint cancellation and fresh generation recover only remaining bytes with independent full hash',async()=>{
  const f=fixture(1_048_593);await f.partial();const before=f.metadata();assert.equal(before.checkpoint.offset,65536);assert.equal(before.checkpoint.sha256,digest(f.bytes.subarray(0,65536)));assert.ok(!JSON.stringify(before).match(/token|grant|sessionId/));
  f.rebind();f.reads.length=0;const updates=[];const receipt=await streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true,onProgress:p=>updates.push(p)});
  assert.equal(f.reads[0],65536);assert.equal(receipt.resumedBytes,65536);assert.equal(receipt.receivedBytes,f.bytes.length-65536);assert.equal(receipt.verification,'stored');assert.equal(receipt.storedSha256,digest(f.bytes));assert.deepEqual(f.storage.files.get(f.names.data).bytes,f.bytes);assert.equal(f.metadata().state,'complete');assert.equal(f.storage.held.size,0);assert.ok(f.storage.state.maxRead<=65536&&f.storage.state.maxWrite<=65536);assert.equal(updates.at(-1).verified,true);
});
test('uncheckpointed data tail is trimmed only after valid saved prefix; metadata-ahead falls back one verified checkpoint',async()=>{
  for(const mode of ['tail','ahead']){const f=fixture();await f.partial(2);const data=f.storage.files.get(f.names.data);
    if(mode==='tail')data.bytes=Buffer.concat([data.bytes,Buffer.alloc(17,9)]);else data.bytes=Buffer.from(data.bytes.subarray(0,65536+9));
    f.reads.length=0;const receipt=await streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true});assert.equal(receipt.resumedBytes,mode==='tail'?131072:65536);assert.equal(f.reads[0],receipt.resumedBytes);assert.equal(receipt.storedSha256,digest(f.bytes));
  }
});
test('corrupt prefix never falls back and missing or truncated files never silently restart',async()=>{
  for(const mode of ['corrupt','short','missing-data','missing-metadata']){const f=fixture();await f.partial(2);const data=f.storage.files.get(f.names.data);
    if(mode==='corrupt')data.bytes[0]^=1;else if(mode==='short')data.bytes=Buffer.alloc(1);else f.storage.files.delete(f.names[mode==='missing-data'?'data':'metadata']);
    f.reads.length=0;const count=f.storage.state.created;
    await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true}),code(mode.startsWith('missing')?'not_found':'conflict'));assert.equal(f.reads.length,0);assert.equal(f.storage.state.created,count);assert.equal(f.storage.held.size,0);
  }
});
test('metadata atomic close failure conservatively recovers old or newly persisted checkpoint',async()=>{
  for(const mode of ['before','after']){const f=fixture();await f.partial();f.storage.state.failMetadata=mode;
    await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true}),code(mode==='before'?'budget_exceeded':'unavailable'));
    assert.equal(f.metadata().checkpoint.offset,mode==='before'?65536:131072);f.reads.length=0;
    const receipt=await streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true});assert.equal(receipt.resumedBytes,mode==='before'?65536:131072);assert.equal(receipt.storedSha256,digest(f.bytes));
  }
});
test('partial data writes preserve the last flushed metadata and repair only the uncheckpointed tail',async()=>{
  const f=fixture();await f.partial();f.storage.state.failData='short';await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true}),code('unavailable'));assert.equal(f.metadata().checkpoint.offset,65536);
  const receipt=await streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true});assert.equal(receipt.resumedBytes,65536);assert.equal(receipt.storedSha256,digest(f.bytes));
});
test('exclusive Web Lock rejects other sink instances until owner closes and is not stolen',async()=>{
  const f=fixture(),signal=new AbortController().signal,input={artifact:f.reference.snapshot.artifact,storedReference:f.reference,signal};
  const first=await f.sink().open(input);await first.write({offset:0,bytes:f.bytes.subarray(0,65536),signal});
  await assert.rejects(f.sink().open({...input,resume:true}),code('conflict'));assert.equal(f.storage.held.size,1);await first.abort({reason:'selected cancel'});assert.equal(f.storage.held.size,0);
  assert.equal((await streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true})).resumedBytes,65536);
});
test('current authorization and complete stored identity are required before opening or reusing a partial',async()=>{
  const f=fixture();await f.partial();f.deny();const sync=f.storage.state.sync;
  await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true}),code('permission_denied'));assert.equal(f.storage.state.sync,sync);f.allow();
  const oldSink=f.sink();f.rebind();await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:oldSink,resume:true}),code('conflict'));
  for(const field of ['storeId','workspaceIdentity','snapshotId','jobId','pluginId','pluginArtifactSha256']){
    const reference={...f.reference,snapshot:{...f.reference.snapshot,[field]:field.endsWith('Sha256')||field==='workspaceIdentity'?'f'.repeat(64):field==='pluginId'?'another-plugin':randomUUID()}};
    const changed={...f.client,async getStoredJobArtifact(){return reference;}};
    await assert.rejects(streamStoredJobArtifact(changed,reference,{sink:f.sink({reference}),resume:true}),code('conflict'));
  }
});
test('expired local retention is enforced even with a current host reference; no files are deleted',async()=>{
  const f=fixture();await f.partial();const time=Date.now;
  Date.now=()=>f.metadata().expiresAt+1;
  try{await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true}),code('unavailable'));assert.equal(f.storage.files.size,2);}finally{Date.now=time;}
});
test('malformed, oversized, checksummed identity changes and unexpected metadata writes fail closed',async()=>{
  for(const mode of ['checksum','oversized','identity','unknown-field']){const f=fixture();await f.partial();const meta=f.storage.files.get(f.names.metadata);
    if(mode==='checksum'){const value=f.metadata();value.checkpoint.sha256='e'.repeat(64);meta.bytes=Buffer.from(JSON.stringify(value));}
    if(mode==='oversized')meta.bytes=Buffer.alloc(16385,32);
    if(mode==='identity')f.rewrite(value=>{value.snapshot.storeId=randomUUID();});
    if(mode==='unknown-field')f.rewrite(value=>{value.token='not-a-token';});
    await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true}));assert.equal(f.storage.held.size,0);
  }
  const f=fixture(),signal=new AbortController().signal,s=await f.sink().open({artifact:f.reference.snapshot.artifact,storedReference:f.reference,signal});f.rewrite(v=>{v.expiresAt--;});
  await assert.rejects(s.write({offset:0,bytes:f.bytes.subarray(0,65536),signal}),code('conflict'));await s.abort({reason:'done'});assert.equal(f.storage.files.get(f.names.data).bytes.length,0);
});
test('new partial never overwrites an existing ID; unsupported setup and bounds do not request permissions',async()=>{
  const f=fixture();await f.partial();await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:f.sink()}),code('conflict'));
  assert.throws(()=>f.sink({retentionMs:86400001}),code('invalid_request'));assert.throws(()=>f.sink({partialId:'../outside'}),code('invalid_request'));assert.throws(()=>f.sink({locks:{}}),code('unsupported'));
  assert.equal(getBrowserArtifactResumeSupport().supported,false);
  const v=f.metadata();assert.deepEqual(parseBrowserArtifactCheckpoint(v),v);assert.throws(()=>parseBrowserArtifactCheckpoint({...v,checksum:'a'.repeat(64)}),code('conflict'));
});
test('empty and already completed recovery still ask the host for a validated EOF without downloading the prefix',async()=>{
  for(const size of [0,65536]){const f=fixture(size),first=await streamStoredJobArtifact(f.client,f.reference,{sink:f.sink()});assert.equal(first.verification,'stored');f.reads.length=0;
    const second=await streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true});assert.equal(second.resumedBytes,size);assert.equal(second.receivedBytes,0);assert.deepEqual(f.reads,[size]);assert.equal(second.storedSha256,digest(f.bytes));
  }
});
test('core independently rejects forged sink prefix before network bytes, even when sink claims recovery',async()=>{
  const f=fixture(),base=f.sink();await f.partial();let aborted=0;const forged={capabilities:base.capabilities,async open(input){const session=await base.open(input);return{...session,recovery:{...session.recovery,sha256:'0'.repeat(64)},async abort(input){aborted++;await session.abort(input);}};}};
  f.reads.length=0;await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:forged,resume:true}),code('conflict'));assert.equal(f.reads.length,0);assert.equal(aborted,1);assert.equal(f.storage.held.size,0);
});
test('queue progress separates recovered prefix from newly transferred bytes and verifies final storage',async()=>{
  const f=fixture();await f.partial();const queue=createTransferQueue({concurrency:1,perConnection:1}),events=[];queue.subscribe(event=>events.push(event));
  try{const job=queue.enqueueStoredDownload(f.client,f.reference,{sink:f.sink(),resume:true});const receipt=await job.result;assert.equal(receipt.resumedBytes,65536);assert.equal(job.snapshot.resumedBytes,65536);assert.equal(job.snapshot.transferredBytes,f.bytes.length-65536);assert.equal(job.snapshot.acknowledgedBytes,f.bytes.length);assert.equal(job.snapshot.attemptedBytes,f.bytes.length-65536);assert.equal(job.snapshot.verified,true);assert.ok(events.some(e=>e.phase==='verifying-prefix'&&!e.verified));}finally{await queue.dispose();}
});
test('four open partial sessions are bounded and cancelled pause releases their locks',async()=>{
  const sessions=[];try{for(let i=0;i<4;i++){const f=fixture(),signal=new AbortController().signal;sessions.push(await f.sink().open({artifact:f.reference.snapshot.artifact,storedReference:f.reference,signal}));}
    const f=fixture();await assert.rejects(streamStoredJobArtifact(f.client,f.reference,{sink:f.sink()}),code('budget_exceeded'));assert.equal(f.storage.state.created,0);
  }finally{for(const session of sessions)await session.close();}
  const f=fixture(),queue=createTransferQueue();let paused=false;
  const job=queue.enqueueStoredDownload(f.client,f.reference,{sink:f.sink(),onProgress:p=>{if(p.receivedBytes===65536){paused=true;job.pause();}}});
  for(let n=0;n<200&&!paused;n++)await delay(5);assert.ok(paused);await queue.dispose();await assert.rejects(job.result,code('cancelled'));assert.equal(f.storage.held.size,0);assert.equal(f.metadata().checkpoint.offset,65536);
});
test('real HTTP stored snapshot resumes with a fresh host generation after source deletion and rejects revoked grants',async()=>{
  const host=await createResumeFixture({fileBytes:262_161}),storage=fakeStorage(),partialId=randomUUID();
  try{
    const get=()=>host.client.getStoredJobArtifact(host.config.pluginId,host.config.jobId,host.config.artifactId,host.config.artifactSha256),reference=await get();
    const sink=reference=>createOpfsArtifactSink({directory:storage.directory,locks:storage.locks,partialId,reference}),controller=new AbortController();
    await assert.rejects(streamStoredJobArtifact(host.client,reference,{sink:sink(reference),signal:controller.signal,onProgress:p=>{if(p.receivedBytes>=65536)controller.abort();}}),code('cancelled'));
    await host.restart({grants:[]});await assert.rejects(get(),code('permission_denied'));
    await host.restart();const fresh=await get();assert.notEqual(fresh.scope.sessionId,reference.scope.sessionId);assert.deepEqual(fresh.snapshot,reference.snapshot);
    await assert.rejects(streamStoredJobArtifact(host.client,reference,{sink:sink(reference),resume:true}),code('generation_mismatch'));
    const receipt=await streamStoredJobArtifact(host.client,fresh,{sink:sink(fresh),resume:true});assert.equal(receipt.resumedBytes,65536);assert.equal(receipt.storedSha256,host.config.sha256);assert.equal(host.executions,1);
  }finally{await host.close();}
});
test('abort drains an in-flight metadata close before releasing cross-tab ownership',async()=>{
  const f=fixture(),signal=new AbortController().signal,input={artifact:f.reference.snapshot.artifact,storedReference:f.reference,signal},session=await f.sink().open(input);
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});f.storage.state.closeGate={enter:entered,wait};
  const writing=session.write({offset:0,bytes:f.bytes.subarray(0,65536),signal});const rejected=assert.rejects(writing,code('disposed'));await started;
  const closing=session.abort({reason:'close during metadata commit'});assert.equal(f.storage.held.size,1);
  await assert.rejects(f.sink().open({...input,resume:true}),code('conflict'));release();await rejected;await closing;assert.equal(f.storage.held.size,0);
  const receipt=await streamStoredJobArtifact(f.client,f.reference,{sink:f.sink(),resume:true});assert.equal(receipt.resumedBytes,65536);assert.equal(receipt.storedSha256,digest(f.bytes));
});
