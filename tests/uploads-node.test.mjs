import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createNodeWorkspace} from '../src/workspace-node.mjs';
import {createNodeUploadStore} from '../src/uploads-node.mjs';
import {parseUploadStatus,parseUploadSpec,parseUploadReference,EMPTY_UPLOAD_SHA256} from '../src/uploads.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pluginId='org.example.upload',artifactSha256='a'.repeat(64);
const spec=(bytes,extra={})=>({uploadId:randomUUID(),pluginId,artifactSha256,path:'input/result.bin',byteLength:bytes.length,sha256:hash(bytes),expectedRevision:null,...extra});
const chunk=(bytes,offset=0)=>({offset,data:Buffer.from(bytes).toString('base64'),sha256:hash(bytes)});
const query=s=>({uploadId:s.uploadId,pluginId:s.pluginId,artifactSha256:s.artifactSha256});
async function fixture(t,options={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-upload-test-'))),workspaceRoot=path.join(root,'workspace'),directory=path.join(root,'staging');
  await fs.mkdir(path.join(workspaceRoot,'input'),{recursive:true});const workspace=await createNodeWorkspace({root:workspaceRoot,writable:options.writable??true,binaryArtifacts:true}),scope={projectId:randomUUID(),sessionId:randomUUID()},stores=[];
  const configuration={workspace,scope,directory,principalId:'test-operator',roots:['input'],fileSystem:'local',authorize:()=>true,...options};
  const open=async(extra={})=>{const store=await createNodeUploadStore({...configuration,...extra});stores.push(store);return store;};
  t.after(async()=>{for(const store of stores.reverse())await store.close();workspace.dispose();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-upload-test-'));await fs.rm(root,{recursive:true});});
  return{root,workspaceRoot,directory,workspace,scope,open};
}
async function fill(store,bytes,extra={}){let status=await store.begin(spec(bytes,extra));for(let offset=0;offset<bytes.length;offset+=65536)status=await store.write(status.reference,chunk(bytes.subarray(offset,offset+65536),offset));return status;}
async function checkpoint(file,change){const value=JSON.parse(await fs.readFile(file,'utf8'));change(value.record);value.sha256=hash(JSON.stringify(value.record));await fs.writeFile(file,JSON.stringify(value));}

test('upload stages bounded binary chunks outside workspace, deduplicates and commits with a stored receipt',async t=>{
  const f=await fixture(t),store=await f.open(),bytes=Buffer.alloc(2*1024*1024+17,0xa5),s=spec(bytes);let status=await store.begin(s);
  assert.deepEqual(await f.workspace.listFiles('input'),[]);assert.equal(status.prefixSha256,EMPTY_UPLOAD_SHA256);
  assert.deepEqual(await store.begin(s),status);const original=structuredClone(status);assert.throws(()=>{status.reference.spec.path='input/forged';},TypeError);assert.throws(()=>{status.offset=44;},TypeError);
  assert.deepEqual(await store.query(query(s)),original);assert.throws(()=>{store.identity.principalId='other';},TypeError);assert.equal(store.identity.principalId,'test-operator');
  status=await store.write(original.reference,chunk(bytes.subarray(0,65536)));assert.equal(status.offset,65536);
  assert.deepEqual(await store.write(status.reference,chunk(bytes.subarray(0,65536))),status);
  await assert.rejects(store.write(status.reference,chunk(Buffer.alloc(8),4)),{code:'conflict'});
  await assert.rejects(store.write(status.reference,chunk(bytes.subarray(0,16),65530)),{code:'conflict'});
  await assert.rejects(store.write(status.reference,chunk(bytes.subarray(0,16),65540)),{code:'conflict'});
  assert.throws(()=>store.write(status.reference,{...chunk(Buffer.from('x')),sha256:'b'.repeat(64)}),{code:'conflict'});
  for(let at=status.offset;at<bytes.length;at+=65536)status=await store.write(status.reference,chunk(bytes.subarray(at,at+65536),at));
  assert.equal(status.prefixSha256,s.sha256);assert.deepEqual(await f.workspace.listFiles('input'),[]);
  const committed=await store.commit(status.reference);assert.equal(committed.state,'committed');assert.equal(committed.commitReceipt.revision,hash(bytes));assert.equal(hash(await fs.readFile(path.join(f.workspaceRoot,s.path))),s.sha256);
  assert.deepEqual(await store.commit(status.reference),committed);assert.deepEqual(await store.abort(status.reference),committed);assert.deepEqual(await store.query(query(s)),committed);
  assert.deepEqual((await fs.readdir(f.directory)).sort(),['.writer.lock',s.uploadId+'.json','store.json'].sort());
});

test('upload commit checks complete size, full hash and binary create/update CAS including empty files',async t=>{
  const f=await fixture(t),store=await f.open(),bytes=Buffer.from([0,255,128,1]);
  let s=await store.begin(spec(bytes));await assert.rejects(store.commit(s.reference),{code:'conflict'});s=await store.write(s.reference,chunk(bytes));
  await fs.writeFile(path.join(f.workspaceRoot,'input/result.bin'),'external');await assert.rejects(store.commit(s.reference),{code:'conflict'});assert.equal(await fs.readFile(path.join(f.workspaceRoot,'input/result.bin'),'utf8'),'external');await store.abort(s.reference);
  const update=await fill(store,bytes,{expectedRevision:hash('external')});await store.commit(update.reference);assert.equal(hash(await fs.readFile(path.join(f.workspaceRoot,'input/result.bin'))),hash(bytes));
  const bad=await fill(store,Buffer.from('wrong'),{path:'input/bad.bin',sha256:hash('right')});await assert.rejects(store.commit(bad.reference),{code:'conflict'});assert.equal((await store.query(query(bad.reference.spec))).state,'corrupt');
  const empty=await fill(store,Buffer.alloc(0),{path:'input/empty.bin'});assert.equal((await store.commit(empty.reference)).state,'committed');assert.equal((await fs.stat(path.join(f.workspaceRoot,'input/empty.bin'))).size,0);
});

test('fresh host recovery requires explicit current authority, rehashes prefix and rejects old references',async t=>{
  let allowed=true;const f=await fixture(t,{authorize:()=>allowed}),first=await f.open(),bytes=Buffer.alloc(100000,7),s=spec(bytes);const begun=await first.begin(s),partial=await first.write(begun.reference,chunk(bytes.subarray(0,65536)));await first.close();
  await fs.appendFile(path.join(f.directory,s.uploadId+'.part'),Buffer.from('uncheckpointed-tail'));
  const scope={...f.scope,sessionId:randomUUID()},next=await f.open({scope});await assert.rejects(next.query(query(s)),{code:'generation_mismatch'});
  allowed=false;await assert.rejects(next.query({...query(s),recover:true}),{code:'permission_denied'});allowed=true;
  let recovered=await next.query({...query(s),recover:true});assert.equal(recovered.offset,65536);assert.equal(recovered.reference.scope.sessionId,scope.sessionId);assert.equal((await fs.stat(path.join(f.directory,s.uploadId+'.part'))).size,65536);
  await assert.rejects(next.write(partial.reference,chunk(bytes.subarray(65536),65536)),{code:'generation_mismatch'});
  recovered=await next.write(recovered.reference,chunk(bytes.subarray(65536),65536));await next.commit(recovered.reference);
  await next.close();const again=await f.open({scope:{...scope,sessionId:randomUUID()}});assert.equal((await again.query({...query(s),recover:true})).state,'committed');
});

test('corrupt or missing prefixes never resume and metadata tampering fails closed',async t=>{
  const f=await fixture(t),store=await f.open(),s=await fill(store,Buffer.from('prefix'),{path:'input/corrupt'});await store.close();
  await fs.writeFile(path.join(f.directory,s.reference.spec.uploadId+'.part'),'broken');const next=await f.open();assert.equal((await next.query(query(s.reference.spec))).state,'corrupt');await assert.rejects(next.commit(s.reference),{code:'conflict'});await next.abort(s.reference);
  const missing=await next.begin(spec(Buffer.from('x'),{path:'input/missing'}));await fs.unlink(path.join(f.directory,missing.reference.spec.uploadId+'.part'));assert.equal((await next.query(query(missing.reference.spec))).state,'corrupt');await next.close();
  await fs.appendFile(path.join(f.directory,s.reference.spec.uploadId+'.json'),'x');await assert.rejects(f.open(),{code:'unavailable'});
});

test('upload scope, plugin pins, lifetime, limits and TTL are enforced without exposing private parts',async t=>{
  let allowed=true;const f=await fixture(t,{authorize:()=>allowed,limits:{active:1,fileBytes:32,storeBytes:32,retentionMs:10000}}),store=await f.open(),s=await store.begin(spec(Buffer.from('abc')));
  await assert.rejects(store.begin(spec(Buffer.from('x'),{path:'input/other'})),{code:'budget_exceeded'});
  await assert.rejects(store.query({...query(s.reference.spec),pluginId:'org.example.other'}),{code:'plugin_mismatch'});
  await assert.rejects(store.begin(spec(Buffer.alloc(33))),{code:'budget_exceeded'});await assert.rejects(store.begin(spec(Buffer.from('x'),{path:'outside.bin'})),{code:'permission_denied'});
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(store.query(query(s.reference.spec),{signal:cancelled.signal}),{code:'cancelled'});
  allowed=false;await assert.rejects(store.write(s.reference,chunk(Buffer.from('abc'))),{code:'permission_denied'});allowed=true;
  const realNow=Date.now;t.mock.method(Date,'now',()=>realNow()+20000);assert.equal((await store.query(query(s.reference.spec))).state,'expired');assert.deepEqual((await store.prune()).removed,[s.reference.spec.uploadId]);t.mock.restoreAll();
  const fresh=await store.begin(spec(Buffer.from('abc')));assert.equal((await store.abort(fresh.reference)).state,'aborted');assert.equal(store.inspect().reservedBytes,0);store.revoke();await assert.rejects(store.query(query(fresh.reference.spec)),{code:'permission_denied'});
});

test('upload store rejects overlap, links, read-only/custom workspaces, live writers and changed principals',async t=>{
  const f=await fixture(t),store=await f.open();await assert.rejects(f.open(),{code:'conflict'});await assert.rejects(f.open({recoverStaleLock:true}),{code:'conflict'});
  await assert.rejects(f.open({directory:path.join(f.workspaceRoot,'staging')}),{code:'unsafe_path'});await assert.rejects(f.open({workspace:{capabilities:{write:true}}}),{code:'permission_denied'});
  const readonly=await createNodeWorkspace({root:f.workspaceRoot,writable:false});t.after(()=>readonly.dispose());await assert.rejects(f.open({workspace:readonly}),{code:'permission_denied'});
  await fs.mkdir(path.join(f.root,'outside'));await fs.symlink(path.join(f.root,'outside'),path.join(f.workspaceRoot,'input/link'),process.platform==='win32'?'junction':'dir');await assert.rejects(store.begin(spec(Buffer.from('x'),{path:'input/link/escape'})),{code:'unsafe_path'});
  await fs.writeFile(path.join(f.workspaceRoot,'input/hard'),'x');await fs.link(path.join(f.workspaceRoot,'input/hard'),path.join(f.root,'alias'));await assert.rejects(store.begin(spec(Buffer.from('x'),{path:'input/hard'})),{code:'unsafe_path'});
  await store.close();await assert.rejects(f.open({principalId:'other'}),{code:'conflict'});await assert.rejects(f.open({scope:{projectId:randomUUID(),sessionId:randomUUID()}}),{code:'conflict'});
});

test('lost commit response and crashes before/after publication reconcile from durable identity',async t=>{
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});
  const f=await fixture(t),store=await f.open(),bytes=Buffer.from('published'),s=await fill(store,bytes),originalRename=fs.rename;let lost=false;
  t.mock.method(fs,'rename',async function(from,to){if(String(to).endsWith(s.reference.spec.uploadId+'.json')){const record=JSON.parse(await fs.readFile(from,'utf8')).record;if(record.status.state==='committed'&&!lost){lost=true;throw Object.assign(Error('simulated IO failure before receipt save'),{code:'EIO'});}}return originalRename.call(this,from,to);});syncBuiltinESMExports();
  await assert.rejects(store.commit(s.reference),{code:'unavailable'});assert.equal(lost,true);assert.equal(hash(await fs.readFile(path.join(f.workspaceRoot,'input/result.bin'))),hash(bytes));t.mock.restoreAll();syncBuiltinESMExports();
  assert.equal((await store.query(query(s.reference.spec))).state,'committed');await store.close();
  const next=await f.open(),before=await fill(next,Buffer.from('before'),{path:'input/before.bin'});await next.close();const metadata=path.join(f.directory,before.reference.spec.uploadId+'.json'),temp=path.join(f.workspaceRoot,'input','.dds-write-upload-'+before.reference.uploadGeneration);await fs.writeFile(temp,'partial copy');const stat=await fs.stat(temp,{bigint:true});
  await checkpoint(metadata,r=>{r.status.state='committing';r.publication={dev:String(stat.dev),ino:String(stat.ino)};});const resumed=await f.open();assert.equal((await resumed.query(query(before.reference.spec))).state,'receiving');await assert.rejects(fs.stat(temp),{code:'ENOENT'});await resumed.commit(before.reference);await resumed.close();
  const last=await f.open(),linked=await fill(last,Buffer.from('link crash'),{path:'input/linked.bin'});await last.close();const linkTemp=path.join(f.workspaceRoot,'input','.dds-write-upload-'+linked.reference.uploadGeneration);await fs.writeFile(linkTemp,'link crash');const inode=await fs.stat(linkTemp,{bigint:true});await fs.link(linkTemp,path.join(f.workspaceRoot,'input/linked.bin'));
  await checkpoint(path.join(f.directory,linked.reference.spec.uploadId+'.json'),r=>{r.status.state='committing';r.publication={dev:String(inode.dev),ino:String(inode.ino)};});const recovered=await f.open();assert.equal((await recovered.query(query(linked.reference.spec))).state,'committed');assert.equal((await fs.stat(path.join(f.workspaceRoot,'input/linked.bin'))).nlink,1);
});

test('ambiguous publication stays uncertain and abort does not pretend to undo a commit',async t=>{
  const f=await fixture(t),store=await f.open(),s=await fill(store,Buffer.from('data'));await store.close();await checkpoint(path.join(f.directory,s.reference.spec.uploadId+'.json'),r=>{r.status.state='committing';r.publication={dev:'1',ino:'2'};});
  const next=await f.open();assert.equal((await next.query(query(s.reference.spec))).state,'uncertain');assert.equal((await next.abort(s.reference)).state,'uncertain');await assert.rejects(next.commit(s.reference),{code:'conflict'});
});

test('upload contracts reject invalid identities, empty-file hashes and mismatched receipts',()=>{
  assert.throws(()=>parseUploadSpec(spec(Buffer.alloc(0),{sha256:'a'.repeat(64)})),{code:'invalid_request'});assert.throws(()=>parseUploadSpec(spec(Buffer.from('x'),{path:'../x'})),{code:'unsafe_path'});
  assert.throws(()=>parseUploadReference({}),{code:'invalid_request'});assert.throws(()=>parseUploadStatus({}),{code:'invalid_request'});
});

test('failed checkpoint writes clean their owned temporary files and resume only the acknowledged offset',async t=>{
  t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});const f=await fixture(t),store=await f.open(),s=await store.begin(spec(Buffer.from('quota'))),originalOpen=fs.open;
  t.mock.method(fs,'open',async function(file,...args){const handle=await originalOpen.call(this,file,...args);if(path.basename(String(file)).startsWith('.checkpoint-'))t.mock.method(handle,'writeFile',async()=>{throw Object.assign(Error('quota'),{code:'ENOSPC'});});return handle;});syncBuiltinESMExports();
  for(let n=0;n<2;n++){await assert.rejects(store.write(s.reference,chunk(Buffer.from('quota'))),{code:'budget_exceeded'});assert.equal((await fs.readdir(f.directory)).filter(name=>name.startsWith('.checkpoint-')).length,0);}
  t.mock.restoreAll();syncBuiltinESMExports();const saved=await store.query(query(s.reference.spec));assert.equal(saved.offset,0);assert.equal((await fs.stat(path.join(f.directory,s.reference.spec.uploadId+'.part'))).size,0);await store.write(saved.reference,chunk(Buffer.from('quota')));assert.equal((await store.commit(saved.reference)).state,'committed');
});

test('stale writer recovery requires explicit opt-in and a definitely exited local process',async t=>{
  const f=await fixture(t),store=await f.open();await store.close();
  const child=spawn(process.execPath,['--input-type=module','-e','process.stdout.write(String(process.pid))'],{windowsHide:true,stdio:['ignore','pipe','ignore']});let output='';const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});for await(const bytes of child.stdout)output+=bytes;await closed;const pid=Number(output);assert.ok(pid>0);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  await fs.writeFile(path.join(f.directory,'.writer.lock'),JSON.stringify({pid,host:os.hostname(),token:randomUUID()}));await assert.rejects(f.open(),{code:'conflict'});const recovered=await f.open({recoverStaleLock:true});assert.equal(recovered.capabilities().enabled,true);await recovered.close();
  await fs.writeFile(path.join(f.directory,'.writer.lock'),JSON.stringify({pid,host:'unknown-host.example',token:randomUUID()}));await assert.rejects(f.open({recoverStaleLock:true}),{code:'conflict'});
});
