import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {createNodeJobStore} from '../src/job-storage-node.mjs';
import {createNodeArtifactStore} from '../src/artifact-storage-node.mjs';
import {decodeBinaryArtifactData} from '../src/artifacts.mjs';
import {parseStoredArtifact} from '../src/artifact-storage.mjs';
import {deferred} from './fixtures.mjs';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function source(bytes,change){const value={path:'trace.bin',revision:digest(bytes),byteLength:bytes.length,async readChunk(offset,length){const chunk=bytes.subarray(offset,offset+length);return change?change(offset,length,chunk):{offset,nextOffset:offset+chunk.length,eof:offset+chunk.length===bytes.length,data:chunk.toString('base64'),sha256:digest(chunk)};}};return value;}
function request(value,extra={}){return{jobId:randomUUID(),pluginId:'example',pluginArtifactSha256:'a'.repeat(64),kind:'binary',artifact:{id:'trace',path:value.path,revision:value.revision,byteLength:value.byteLength},...extra};}
async function fixture(t,options={}){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'dds-artifact-store-'))),root=path.join(directory,'project'),storage=path.join(directory,'store'),workspaceId=randomUUID();await fs.mkdir(root);const jobs=[],stores=[];
  async function open(extra={}){const jobStore=await createNodeJobStore({directory:storage,workspaceRoot:root,workspaceId,...extra});jobs.push(jobStore);const artifacts=await createNodeArtifactStore({jobStore,...options});stores.push(artifacts);return{jobStore,artifacts};}
  t.after(async()=>{for(const s of stores)await s.close();for(const j of jobs)await j.close().catch(()=>{});assert.equal(await fs.realpath(directory),directory);assert.ok(path.basename(directory).startsWith('dds-artifact-store-'));await fs.rm(directory,{recursive:true});});return{root,storage,workspaceId,open};
}

test('snapshots copy bounded binary bytes, verify full digest and survive a store restart',async t=>{
  const f=await fixture(t),first=await f.open(),bytes=Buffer.alloc(131079,137),input=source(bytes);
  const stored=await first.artifacts.capture(request(input),input);assert.equal(parseStoredArtifact(stored).artifact.revision,digest(bytes));assert.equal(first.artifacts.status(stored),'retained');
  const reordered=Object.fromEntries(Object.entries(stored).reverse());reordered.artifact=Object.fromEntries(Object.entries(stored.artifact).reverse());
  assert.equal(first.artifacts.status(reordered),'retained');assert.deepEqual(await first.artifacts.verify(reordered),stored);
  const chunk=await first.artifacts.readChunk(stored,65000,64000);assert.deepEqual(Buffer.from(decodeBinaryArtifactData(chunk.data)),bytes.subarray(65000,129000));
  assert.equal(first.artifacts.inspect().files,1);assert.equal(first.artifacts.inspect().orphanCount,0);
  await assert.rejects(createNodeArtifactStore({jobStore:first.jobStore}),{code:'conflict'});
  await first.artifacts.close();await first.jobStore.close();const second=await f.open();assert.deepEqual(await second.artifacts.verify(stored),stored);
  assert.deepEqual(Buffer.from(decodeBinaryArtifactData((await second.artifacts.readChunk(stored,131079,1)).data)),Buffer.alloc(0));
});

test('forged streams, cancellation and quotas never publish an incomplete snapshot',async t=>{
  const f=await fixture(t,{maxBytes:100000,maxFiles:1}),{artifacts}=await f.open();
  const real=Buffer.from('verified'),bad=source(real,()=>({offset:0,nextOffset:real.length,eof:true,data:Buffer.alloc(real.length).toString('base64'),sha256:digest(Buffer.alloc(real.length))}));
  await assert.rejects(artifacts.capture(request(bad),bad),{code:'conflict'});assert.equal(artifacts.inspect().files,0);assert.equal(artifacts.inspect().bytes,0);
  const cancelled=new AbortController(),large=source(Buffer.alloc(90000),async(offset,length,chunk)=>{cancelled.abort();return{offset,nextOffset:offset+chunk.length,eof:false,data:chunk.toString('base64'),sha256:digest(chunk)};});
  await assert.rejects(artifacts.capture(request(large),large,{signal:cancelled.signal}),{code:'cancelled'});assert.equal(artifacts.inspect().bytes,0);
  const over=source(Buffer.alloc(100001));await assert.rejects(artifacts.capture(request(over),over),{code:'budget_exceeded'});
  const valid=source(real);await artifacts.capture(request(valid),valid);await assert.rejects(artifacts.capture(request(valid),valid),{code:'budget_exceeded'});assert.equal(artifacts.inspect().files,1);
});

test('tampered, missing and linked snapshot files fail verification without exposing unrelated bytes',async t=>{
  const f=await fixture(t),{artifacts}=await f.open(),input=source(Buffer.from('private synthetic result'));
  const corrupt=await artifacts.capture(request(input),input),missing=await artifacts.capture(request(input),input),linked=await artifacts.capture(request(input),input);
  const dir=path.join(f.storage,'artifacts');await fs.writeFile(path.join(dir,corrupt.snapshotId+'.bin'),'modified synthetic bytes');
  await assert.rejects(artifacts.verify(corrupt),{code:'conflict'});assert.equal(artifacts.status(corrupt),'corrupt');
  await fs.unlink(path.join(dir,missing.snapshotId+'.bin'));await assert.rejects(artifacts.verify(missing),{code:'capability_unavailable'});assert.equal(artifacts.status(missing),'missing');
  const outside=path.join(f.root,'outside.bin');await fs.link(path.join(dir,linked.snapshotId+'.bin'),outside);await assert.rejects(artifacts.verify(linked),{code:'conflict'});assert.equal(await fs.readFile(outside,'utf8'),'private synthetic result');await fs.unlink(outside);
});

test('job pins and active readers prevent deletion; expiry blocks the next read and pruning is explicit',async t=>{
  const f=await fixture(t),{jobStore,artifacts}=await f.open(),input=source(Buffer.from('kept')),record=await artifacts.capture(request(input),input),release=jobStore.pin(record.jobId);
  await assert.rejects(artifacts.remove(record),{code:'conflict'});release();
  const pending=artifacts.verify(record);assert.equal(artifacts.inspect().activeReaders,1);await assert.rejects(artifacts.remove(record),{code:'conflict'});await pending;
  const clock=Date.now;Date.now=()=>record.expiresAt+1;
  try{assert.equal(artifacts.status(record),'expired');await assert.rejects(artifacts.verify(record),{code:'capability_unavailable'});const result=await artifacts.prune();assert.deepEqual(result.removed,[record.snapshotId]);assert.equal(result.bytes,0);}finally{Date.now=clock;}
  assert.equal(artifacts.status(record),'missing');
});

test('orphan cleanup is explicit after reopening and refuses unexpected directory contents',async t=>{
  const f=await fixture(t),first=await f.open();await first.artifacts.close();await first.jobStore.close();
  const orphan='.capture-'+randomUUID();await fs.writeFile(path.join(f.storage,'artifacts',orphan),'partial');const second=await f.open();assert.equal(second.artifacts.inspect().orphanCount,1);
  assert.deepEqual((await second.artifacts.prune()).removedOrphans,[]);const result=await second.artifacts.prune({orphans:true});assert.deepEqual(result.removedOrphans,[orphan]);assert.equal(result.bytes,0);
});

test('capture checks directory replacement or the platform denies renaming an open staging directory',async t=>{
  const f=await fixture(t),{artifacts}=await f.open(),entered=deferred(),release=deferred(),bytes=Buffer.from('kept');
  const input=source(bytes,async(offset,length,chunk)=>{entered.resolve();await release.promise;return{offset,nextOffset:chunk.length,eof:true,data:chunk.toString('base64'),sha256:digest(chunk)};});
  const result=artifacts.capture(request(input),input);await entered.promise;const dir=path.join(f.storage,'artifacts'),moved=path.join(f.storage,'original-artifacts');let denied=false;
  try{await fs.rename(dir,moved);await fs.mkdir(dir);}catch(error){if(process.platform!=='win32'||error.code!=='EPERM')throw error;denied=true;}finally{release.resolve();}
  if(denied){assert.equal((await result).artifact.revision,digest(bytes));t.diagnostic('Windows denied renaming the directory containing the open staging file.');}
  else{await assert.rejects(result,{code:'conflict'});assert.deepEqual(await fs.readdir(dir),[]);await fs.rmdir(dir);await fs.rename(moved,dir);}
});

test('an uncooperative source is deadline bounded and its late result cannot publish a file',async t=>{
  const f=await fixture(t),{artifacts}=await f.open(),late=deferred(),bytes=Buffer.from('late'),input=source(bytes,()=>late.promise);
  await assert.rejects(artifacts.capture(request(input),input,{timeoutMs:25}),{code:'budget_exceeded'});assert.equal(artifacts.inspect().files,0);assert.equal(artifacts.inspect().bytes,0);
  late.resolve({offset:0,nextOffset:bytes.length,eof:true,data:bytes.toString('base64'),sha256:digest(bytes)});await Promise.resolve();assert.equal(artifacts.inspect().files,0);
});

for(const mode of ['crash','disk-full'])test(`${mode} during a real capture never exposes partial bytes`,{timeout:15000},async t=>{
  const f=await fixture(t),child=fork(fileURLToPath(new URL('./artifact-storage-worker.mjs',import.meta.url)),[JSON.stringify({mode,directory:f.storage,workspaceRoot:f.root,workspaceId:f.workspaceId})],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});
  let stderr='';child.stderr.on('data',data=>stderr+=data);
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  const message=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error(stderr||'Worker exited before its receipt')));});
  if(mode==='crash'){assert.equal(message.staged,true);child.kill('SIGKILL');}
  else assert.deepEqual(message,{code:'budget_exceeded',files:0,bytes:0});
  const exit=await exited;if(mode==='disk-full')assert.equal(exit.code,0,stderr);
  const {artifacts}=await f.open({recoverStaleLock:true});assert.equal(artifacts.inspect().files,0);assert.deepEqual(artifacts.inspect().records,[]);
  if(mode==='crash'){assert.equal(artifacts.inspect().orphanCount,1);assert.equal(artifacts.inspect().bytes,65536);}
  else assert.equal(artifacts.inspect().orphanCount,0);
  await artifacts.prune({orphans:true});assert.equal(artifacts.inspect().bytes,0);
});

test('unsupported and corrupt metadata remain isolated from a verified neighbor',async t=>{
  const f=await fixture(t),first=await f.open(),input=source(Buffer.from('retained'));
  const good=await first.artifacts.capture(request(input),input),bad=await first.artifacts.capture(request(input),input),future=await first.artifacts.capture(request(input),input);
  await first.artifacts.close();await first.jobStore.close();
  await fs.writeFile(path.join(f.storage,'artifacts',bad.snapshotId+'.json'),'{interrupted');
  const record={...future,schemaVersion:2};await fs.writeFile(path.join(f.storage,'artifacts',future.snapshotId+'.json'),JSON.stringify({formatVersion:1,sha256:digest(JSON.stringify(record)),record}));
  const second=await f.open();assert.deepEqual(await second.artifacts.verify(good),good);assert.equal(second.artifacts.status(bad),'corrupt');assert.equal(second.artifacts.status(future),'unsupported');
  await assert.rejects(second.artifacts.verify(bad),{code:'conflict'});await assert.rejects(second.artifacts.verify(future),{code:'version_mismatch'});
});
