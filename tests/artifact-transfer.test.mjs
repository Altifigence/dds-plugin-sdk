import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createIncrementalSha256,streamJobBinaryArtifact,streamStoredJobArtifact,ArtifactTransferError,parseArtifactSinkCapabilities,parseArtifactTransferReceipt} from '../src/artifact-transfer.mjs';
import {createBrowserFileSink,createOpfsFileSink} from '../src/artifact-transfer-browser.mjs';
import {BINARY_ARTIFACT_LIMITS} from '../src/artifacts.mjs';
import {ARTIFACT_STORE_LIMITS} from '../src/artifact-storage.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(length=262_145){
  const bytes=Buffer.alloc(length);for(let i=0;i<length;i++)bytes[i]=(i*31+17)%256;
  const reference={jobId:randomUUID(),scope:{projectId:randomUUID(),sessionId:randomUUID()},artifact:{id:'binary',path:'out/result.bin',revision:digest(bytes),byteLength:length}};
  const state={reads:0,opened:0,writes:0,commits:0,aborts:0,closed:0,pending:0,peak:0};
  const client={binding:{workspace:{id:reference.scope.projectId,generation:reference.scope.sessionId}},async getBinaryArtifactCapabilities(){return{protocolVersion:1,enabled:true,limits:{...BINARY_ARTIFACT_LIMITS}};},async getJobBinaryArtifact(){return reference;},async readJobBinaryArtifactChunk(_ref,offset,{length}){state.reads++;const part=bytes.subarray(offset,offset+length);return{...reference,offset,nextOffset:offset+part.length,eof:offset+part.length===bytes.length,data:part.toString('base64'),sha256:digest(part)};}};
  function sink({readback=true,slow=0,write,commit,corrupt=false}={}){
    const saved=Buffer.alloc(bytes.length);
    return{capabilities:{kind:'caller',seek:false,readback,persistence:'none',abort:'retain'},async open(){state.opened++;return{
      async write(input){state.pending++;state.peak=Math.max(state.peak,state.pending);try{if(write)await write(input);if(slow)await delay(slow);saved.set(input.bytes,input.offset);state.writes++;}finally{state.pending--;}}
      ,async commit(){state.commits++;if(commit)await commit();},async abort(){state.aborts++;},async close(){state.closed++;},
      ...(readback?{async readback(){return{byteLength:saved.length,async read(at,length){const part=new Uint8Array(saved.subarray(at,at+length));if(corrupt&&at===0)part[0]^=1;return part;}};}}:{}),
    };}};
  }
  return{bytes,reference,client,state,sink};
}
function fakeHandle(initial=new Uint8Array(),options={}){
  let bytes=new Uint8Array(initial),modified=1,allowed=true;const state={writes:0,aborts:0,closes:0,permissionRequests:0};
  const handle={kind:'file',async queryPermission(){return allowed?'granted':'denied';},async requestPermission(){state.permissionRequests++;throw new Error('must not request');},async isSameEntry(other){return handle===other;},async getFile(){const snapshot=new Blob([bytes]);return{size:snapshot.size,lastModified:modified,slice:(start,end)=>snapshot.slice(start,end)};},async createWritable(){let parts=[];return{async write(part){if(options.failWrite)throw options.failWrite;parts.push(new Uint8Array(part));state.writes++;if(options.revokeAfterWrite)allowed=false;},async close(){bytes=new Uint8Array(await new Blob(parts).arrayBuffer());modified++;state.closes++;},async abort(){parts=[];state.aborts++;}};}};
  return{handle,state,get bytes(){return bytes;},revoke(){allowed=false;},replace(){bytes=new Uint8Array([9]);modified++;}};
}
const code=expected=>error=>error.code===expected;

test('incremental SHA-256 matches independent crypto across padding boundaries and random chunking',()=>{
  assert.equal(createIncrementalSha256().digest(),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(createIncrementalSha256().update(new TextEncoder().encode('abc')).digest(),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for(const length of [1,55,56,63,64,65,119,120,127,128,129,65535,65536,65537,1_000_000]){
    const bytes=randomBytes(length+3).subarray(3),hash=createIncrementalSha256();for(let at=0;at<length;at+=137)hash.update(bytes.subarray(at,at+137));assert.equal(hash.byteLength,length);assert.equal(hash.digest(),digest(bytes));assert.throws(()=>hash.update(bytes),code('disposed'));assert.throws(()=>hash.digest(),code('disposed'));
  }
  assert.throws(()=>createIncrementalSha256().update(new Uint8Array(new SharedArrayBuffer(1))),code('invalid_request'));
});
test('large stream backpressure, full receive and stored hashes, receipt validation',async()=>{
  const f=fixture(2_097_169),updates=[];const receipt=await streamJobBinaryArtifact(f.client,f.reference,{sink:f.sink({slow:1}),onProgress:value=>updates.push(value)});
  assert.equal(receipt.verification,'stored');assert.equal(receipt.storedSha256,digest(f.bytes));assert.equal(receipt.metrics.peakQueuedChunks,1);assert.equal(receipt.metrics.peakDecodedBytes,65536);assert.equal(f.state.peak,1);assert.equal(f.state.reads,33);assert.equal(f.state.closed,1);assert.equal(f.state.aborts,0);
  assert.ok(updates.slice(0,-1).every(value=>!value.verified));assert.equal(updates.at(-1).verified,true);assert.deepEqual(parseArtifactTransferReceipt(receipt),receipt);
  assert.throws(()=>parseArtifactTransferReceipt({...receipt,storedSha256:null}),code('invalid_request'));assert.throws(()=>parseArtifactTransferReceipt({...receipt,receivedBytes:1}),code('invalid_request'));
});
test('write-only sinks never claim stored verification; empty artifacts still validate EOF',async()=>{
  for(const length of [0,1,65536]){const f=fixture(length),r=await streamJobBinaryArtifact(f.client,f.reference,{sink:f.sink({readback:false})});assert.equal(r.verification,'received');assert.equal(r.storedSha256,null);assert.equal(r.receivedSha256,digest(f.bytes));assert.equal(f.state.reads,1);}
});
test('chunk identity, range, early EOF, canonical data and SHA tampering cannot commit',async()=>{
  for(const mutate of [r=>({...r,offset:r.offset+1}),r=>({...r,scope:{...r.scope,sessionId:randomUUID()}}),r=>({...r,eof:true}),r=>({...r,sha256:'f'.repeat(64)}),r=>({...r,data:r.data+' '}),r=>({...r,nextOffset:r.nextOffset-1})]){
    const f=fixture(),read=f.client.readJobBinaryArtifactChunk;f.client.readJobBinaryArtifactChunk=async(...args)=>mutate(await read(...args));await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink:f.sink()}),error=>error instanceof ArtifactTransferError&&['invalid_request','conflict'].includes(error.code));assert.equal(f.state.commits,0);assert.equal(f.state.aborts,1);
  }
});
test('whole-file mismatch does not commit; stored mismatch reports the already committed result',async()=>{
  const f=fixture();f.reference.artifact.revision='a'.repeat(64);await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink:f.sink()}),e=>e.code==='conflict'&&e.partial.commit==='not-committed'&&!e.partial.receivedVerified);assert.equal(f.state.commits,0);
  const g=fixture();await assert.rejects(streamJobBinaryArtifact(g.client,g.reference,{sink:g.sink({corrupt:true})}),e=>e.code==='conflict'&&e.partial.commit==='committed'&&e.partial.receivedVerified&&!e.partial.storedVerified&&e.partial.disposition==='retained');
});
test('cancel, deadline, connection changes, quotas and permission failures expose partial state',async()=>{
  const f=fixture(),controller=new AbortController();await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink:f.sink(),signal:controller.signal,onProgress:p=>{if(p.phase==='receiving')controller.abort();}}),e=>e.code==='cancelled'&&e.partial.writtenBytes===65536&&e.partial.commit==='not-committed');assert.equal(f.state.reads,1);
  const g=fixture();await assert.rejects(streamJobBinaryArtifact(g.client,g.reference,{sink:g.sink({slow:20}),timeoutMs:5}),code('budget_exceeded'));assert.equal(g.state.pending,0);assert.equal(g.state.commits,0);
  const h=fixture();await assert.rejects(streamJobBinaryArtifact(h.client,h.reference,{sink:h.sink({write:()=>{h.client.binding={...h.client.binding};}})}),code('disposed'));
  for(const [name,expected]of[['QuotaExceededError','budget_exceeded'],['NotAllowedError','permission_denied']]){const j=fixture();await assert.rejects(streamJobBinaryArtifact(j.client,j.reference,{sink:j.sink({write:()=>{throw new DOMException('failure',name);}})}),e=>e.code===expected&&e.partial.writtenBytes===0);assert.equal(j.state.commits,0);}
});
test('disabled/changed sources never open sink, and current reference is required',async()=>{
  const f=fixture();f.client.getBinaryArtifactCapabilities=async()=>({protocolVersion:1,enabled:false,limits:{...BINARY_ARTIFACT_LIMITS}});await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink:f.sink()}),code('unsupported'));assert.equal(f.state.opened,0);
  const g=fixture();g.client.getJobBinaryArtifact=async()=>({...g.reference,artifact:{...g.reference.artifact,revision:'b'.repeat(64)}});await assert.rejects(streamJobBinaryArtifact(g.client,g.reference,{sink:g.sink()}),code('conflict'));assert.equal(g.state.opened,0);
});
test('a throttled timer cannot extend the deadline after suspended execution resumes',async()=>{
  const f=fixture(1),originalNow=Date.now;let clock=originalNow();Date.now=()=>clock;
  try{await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink:f.sink({write:()=>{clock+=1000;}}),timeoutMs:100}),e=>e.code==='budget_exceeded'&&e.partial.commit==='not-committed');assert.equal(f.state.commits,0);}
  finally{Date.now=originalNow;}
});
test('four transfer slots and one session per sink are released after failure',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),fixtures=Array.from({length:5},()=>fixture(1));const sinks=fixtures.map(f=>f.sink({write:()=>gate}));
  const running=fixtures.slice(0,4).map((f,i)=>streamJobBinaryArtifact(f.client,f.reference,{sink:sinks[i]}));
  try{await assert.rejects(streamJobBinaryArtifact(fixtures[0].client,fixtures[0].reference,{sink:sinks[0]}),code('conflict'));await assert.rejects(streamJobBinaryArtifact(fixtures[4].client,fixtures[4].reference,{sink:sinks[4]}),code('budget_exceeded'));}finally{release();await Promise.all(running);}
  assert.equal((await streamJobBinaryArtifact(fixtures[4].client,fixtures[4].reference,{sink:sinks[4]})).verification,'stored');
});
test('commit response failure cannot claim rollback and async callbacks are rejected',async()=>{
  const f=fixture(1);await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink:f.sink({commit:()=>{throw new Error('lost response');}})}),e=>e.partial.commit==='unknown'&&e.partial.disposition==='retained');
  const g=fixture(1);await assert.rejects(streamJobBinaryArtifact(g.client,g.reference,{sink:g.sink(),onProgress:async()=>{}}),code('invalid_request'));assert.equal(g.state.commits,0);
});
test('browser file adapter stores selected bytes, re-reads bounded slices and releases reservation',async()=>{
  const f=fixture(),local=fakeHandle(),sink=createBrowserFileSink(local.handle,{overwrite:false});const receipt=await streamJobBinaryArtifact(f.client,f.reference,{sink});assert.equal(receipt.sink.kind,'file-system-access');assert.equal(receipt.verification,'stored');assert.equal(digest(local.bytes),f.reference.artifact.revision);assert.equal(local.state.permissionRequests,0);
  await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink}),code('conflict'));assert.equal((await streamJobBinaryArtifact(f.client,f.reference,{sink:createBrowserFileSink(local.handle,{overwrite:true})})).verification,'stored');
});
test('browser permission denial/revocation and quota errors never request access or commit',async()=>{
  for(const options of [{denied:true},{revokeAfterWrite:true},{failWrite:new DOMException('full','QuotaExceededError')}]){
    const f=fixture(),local=fakeHandle(new Uint8Array(),options);if(options.denied)local.revoke();await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink:createBrowserFileSink(local.handle,{overwrite:false})}),code(options.failWrite?'budget_exceeded':'permission_denied'));assert.equal(local.bytes.length,0);assert.equal(local.state.closes,0);assert.equal(local.state.permissionRequests,0);
  }
});
test('browser intervening destination change is reported and separate aliases share a reservation',async()=>{
  const f=fixture(1),local=fakeHandle();await assert.rejects(streamJobBinaryArtifact(f.client,f.reference,{sink:createBrowserFileSink(local.handle,{overwrite:false}),onProgress:p=>{if(p.phase==='receiving')local.replace();}}),code('conflict'));assert.equal(local.bytes[0],9);
  const first=fakeHandle(),alias={...first.handle,isSameEntry:async other=>other===first.handle||other===alias};first.handle.isSameEntry=async other=>other===first.handle||other===alias;
  const a=createBrowserFileSink(first.handle,{overwrite:false}),b=createBrowserFileSink(alias,{overwrite:false}),controller=new AbortController();const s=await a.open({artifact:f.reference.artifact,signal:controller.signal});await assert.rejects(b.open({artifact:f.reference.artifact,signal:controller.signal}),code('conflict'));await s.abort({reason:'test'});const next=await b.open({artifact:f.reference.artifact,signal:controller.signal});await next.abort({reason:'test'});
});
test('OPFS adapter uses only explicit directory/name and rejects unsupported or ambiguous inputs',async()=>{
  const f=fixture(),local=fakeHandle();let selected;const directory={kind:'directory',async getFileHandle(name,options){selected={name,options};return local.handle;}};
  const sink=await createOpfsFileSink(directory,'chosen.bin',{overwrite:false});assert.equal((await streamJobBinaryArtifact(f.client,f.reference,{sink})).sink.kind,'opfs');assert.deepEqual(selected,{name:'chosen.bin',options:{create:true}});
  for(const name of ['..','../elsewhere','a/b','a\\b',''])await assert.rejects(createOpfsFileSink(directory,name,{overwrite:false}),code('unsafe_path'));
  assert.throws(()=>createBrowserFileSink({kind:'file'},{overwrite:false}),code('unsupported'));assert.throws(()=>createBrowserFileSink(local.handle,{}),code('invalid_request'));assert.throws(()=>parseArtifactSinkCapabilities({...sink.capabilities,extra:1}),code('invalid_request'));
});
test('stored artifacts bind each request to the complete fresh snapshot identity',async()=>{
  const f=fixture(),now=Date.now(),snapshot={schemaVersion:1,storeId:randomUUID(),workspaceId:f.reference.scope.projectId,workspaceIdentity:'d'.repeat(64),snapshotId:randomUUID(),jobId:f.reference.jobId,pluginId:'example',pluginArtifactSha256:'a'.repeat(64),kind:'binary',artifact:f.reference.artifact,capturedAt:now,expiresAt:now+60000};
  const reference={protocolVersion:1,storage:'snapshot',scope:f.reference.scope,snapshot};
  const client={binding:f.client.binding,async getArtifactStorageCapabilities(){return{protocolVersion:1,enabled:true,identity:{schemaVersion:1,storeId:snapshot.storeId,workspaceId:snapshot.workspaceId,workspaceIdentity:snapshot.workspaceIdentity},limits:ARTIFACT_STORE_LIMITS};},async getStoredJobArtifact(){return reference;},async readStoredJobArtifactChunk(_ref,at,options){const {jobId:_,scope:__,artifact:___,...chunk}=await f.client.readJobBinaryArtifactChunk(f.reference,at,options);return{reference,...chunk};}};
  assert.equal((await streamStoredJobArtifact(client,reference,{sink:f.sink()})).verification,'stored');
  client.getStoredJobArtifact=async()=>({...reference,snapshot:{...snapshot,snapshotId:randomUUID()}});await assert.rejects(streamStoredJobArtifact(client,reference,{sink:f.sink()}),code('conflict'));
});
