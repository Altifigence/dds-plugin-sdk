import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {openSync, writeSync, closeSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkspaceServer, createNodeWorkspace, downloadJobBinaryArtifact} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';
import {definePlugin, createPluginHost} from '../src/index.mjs';
import {BINARY_ARTIFACT_LIMITS, decodeBinaryArtifactData} from '../src/artifacts.mjs';
import {deferred} from './fixtures.mjs';

const token = 'a'.repeat(64), pin = 'b'.repeat(64), notice = {id: 'test', version: '1', text: 'Artifact fixture notice'};
const manifest = {manifestVersion:2,id:'binary-example',name:'Binary example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read'],supportedHosts:['test-host','workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesFor = (size = 1_048_613) => Buffer.from(Array.from({length:size}, (_, index) => (index * 73 + 251) & 255));
async function finished(client, id) {
  const deadline = Date.now() + 10_000;
  for (;;) {const job = await client.getJob(id); if (job.state !== 'running') return job; if (Date.now() > deadline) throw Error('Job did not finish'); await delay(5);}
}
async function fixture(t, {bytes = bytesFor(), options = {}, transport, handler} = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dds-binary-artifacts-')));
  const root = path.join(directory, 'workspace'), downloads = path.join(directory, 'downloads');
  await fs.mkdir(root); await fs.mkdir(downloads); await fs.writeFile(path.join(root, 'trace.bin'), bytes);
  let executions = 0;
  const plugin = definePlugin(manifest, context => context.registerCommand({id:'analyze',title:'Analyze'}, handler ?? (async (_, {job}) => {executions++; await job.addBinaryArtifact({id:'trace',path:'trace.bin',label:'Trace'}); return {artifact:'trace'};})));
  const server = await createWorkspaceServer({root,workspaceId:randomUUID(),token,notice,jobs:true,binaryArtifacts:true,grants:['workspace.read'],plugins:[{plugin,artifactSha256:pin}],...options});
  const client = createWorkspaceClient({url:server.url,token,...(transport ? {fetch:transport} : {})}); await client.connect();
  t.after(async () => {client.dispose(); await server.close(); assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir())); await fs.rm(directory, {recursive:true});});
  const start = async () => {
    const job = await client.startCommandJob(manifest.id, 'analyze', {}, pin, {jobId:randomUUID()});
    return finished(client, job.jobId);
  };
  return {directory,root,downloads,server,client,start,executions:()=>executions};
}

test('a real binary job result downloads in bounded chunks without changing v1 text/jobs', async t => {
  const bytes = bytesFor(), f = await fixture(t, {bytes});
  const capabilities = await f.client.getBinaryArtifactCapabilities(); assert.equal(capabilities.enabled, true); assert.equal(capabilities.limits.chunkBytes, 65_536);
  assert.deepEqual(Object.keys(f.client.binding.capabilities).sort(), ['commands','manage','read','write']);
  const job = await f.start(); assert.equal(job.state, 'succeeded'); assert.deepEqual(job.artifacts, []);
  const events = await f.client.getJobEvents(job.jobId); assert.ok(events.events.every(event => ['state','log','progress','artifact'].includes(event.kind)));
  const reference = await f.client.getJobBinaryArtifact(job.jobId, 'trace'); assert.equal(reference.artifact.revision, sha(bytes)); assert.equal(reference.artifact.byteLength, bytes.length);
  const middle = await f.client.readJobBinaryArtifactChunk(reference, 17, {length:43}); assert.deepEqual(Buffer.from(decodeBinaryArtifactData(middle.data)), bytes.subarray(17,60));
  await assert.rejects(f.client.readFile('trace.bin'), {code:'budget_exceeded'});
  const progress = [], destination = path.join(f.downloads, 'trace.bin');
  const receipt = await downloadJobBinaryArtifact(f.client, reference, {destination,onProgress:update=>{progress.push(update.receivedBytes); assert.equal(update.verified,false);}});
  assert.equal(receipt.verified,true); assert.equal(receipt.resumedBytes,0); assert.equal(receipt.revision,sha(bytes));
  assert.deepEqual(await fs.readFile(destination),bytes); assert.equal(progress.at(-1),bytes.length);
  assert.ok(progress.every((value,index)=>value-(progress[index-1]??0)<=BINARY_ARTIFACT_LIMITS.chunkBytes));
  await assert.rejects(fs.stat(`${destination}.dds-part`),{code:'ENOENT'});
});

test('cancelled download resumes after reconnect using only the retained suffix and rehashes the prefix', async t => {
  const offsets = [], bytes = bytesFor(), f = await fixture(t, {bytes,transport:async (url,options)=>{const request=JSON.parse(options.body); if(request.method==='artifacts.read')offsets.push(request.params.offset); return fetch(url,options);}});
  const job = await f.start(), reference = await f.client.getJobBinaryArtifact(job.jobId,'trace'), destination = path.join(f.downloads,'resumed.bin');
  const controller = new AbortController();
  await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination,signal:controller.signal,onProgress:update=>{if(update.receivedBytes>=131_072)controller.abort();}}),{code:'cancelled'});
  assert.equal((await fs.stat(`${destination}.dds-part`)).size,131_072); await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  f.client.disconnect(); await f.client.connect(); offsets.length=0;
  const receipt = await downloadJobBinaryArtifact(f.client,reference,{destination,resume:true});
  assert.equal(receipt.resumedBytes,131_072); assert.equal(offsets[0],131_072); assert.equal(f.executions(),1); assert.deepEqual(await fs.readFile(destination),bytes);
});

test('empty artifacts and an already complete partial file still receive EOF and whole-file verification', async t => {
  const f = await fixture(t,{bytes:Buffer.alloc(0)}), job=await f.start(), reference=await f.client.getJobBinaryArtifact(job.jobId,'trace');
  const chunk=await f.client.readJobBinaryArtifactChunk(reference,0); assert.equal(chunk.eof,true); assert.equal(chunk.data,''); assert.equal(chunk.sha256,sha(Buffer.alloc(0)));
  const destination=path.join(f.downloads,'empty.bin'); const receipt=await downloadJobBinaryArtifact(f.client,reference,{destination}); assert.equal(receipt.byteLength,0); assert.equal((await fs.stat(destination)).size,0);
  const second=await fixture(t,{bytes:Buffer.from([0,255,128,1])}), secondJob=await second.start(), ref=await second.client.getJobBinaryArtifact(secondJob.jobId,'trace');
  const donePath=path.join(second.downloads,'done.bin'); await fs.writeFile(`${donePath}.dds-part`,Buffer.from([0,255,128,1]));
  assert.equal((await downloadJobBinaryArtifact(second.client,ref,{destination:donePath,resume:true})).resumedBytes,4);
});

test('corrupt resumed bytes never become a final file and existing destinations are preserved', async t => {
  const f=await fixture(t,{bytes:bytesFor(262_201)}),job=await f.start(),reference=await f.client.getJobBinaryArtifact(job.jobId,'trace');
  const destination=path.join(f.downloads,'corrupt.bin'); await fs.writeFile(`${destination}.dds-part`,Buffer.alloc(123,0));
  await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination}),{code:'conflict'});
  await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination,resume:true}),{code:'conflict'});
  await assert.rejects(fs.stat(destination),{code:'ENOENT'}); assert.equal((await fs.stat(`${destination}.dds-part`)).size,reference.artifact.byteLength);
  const existing=path.join(f.downloads,'existing.bin'); await fs.writeFile(existing,'keep');
  await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination:existing}),{code:'conflict'}); assert.equal(await fs.readFile(existing,'utf8'),'keep');
});

test('server opt-in and the plugin read grant are required even for an empty binary result list', async t => {
  const disabled=await fixture(t,{options:{binaryArtifacts:false}}); assert.equal((await disabled.client.getBinaryArtifactCapabilities()).enabled,false);
  await assert.rejects(disabled.client.listJobBinaryArtifacts(randomUUID()),{code:'unsupported'}); assert.equal((await disabled.start()).state,'failed');
  const noJobs=await fixture(t,{options:{jobs:false}}); assert.equal((await noJobs.client.getBinaryArtifactCapabilities()).enabled,false);
  const denied=await fixture(t,{options:{grants:[]}}),job=await denied.start(); assert.equal(job.error.code,'permission_denied');
  await assert.rejects(denied.client.listJobBinaryArtifacts(job.jobId),{code:'permission_denied'});
  const readonly=await fixture(t,{bytes:Buffer.from([255]),options:{writable:false}}),readJob=await readonly.start(); assert.equal(readJob.state,'succeeded');
  assert.equal((await readonly.client.getJobBinaryArtifact(readJob.jobId,'trace')).artifact.byteLength,1);
  const suppliedHost=createPluginHost({hostId:'workspace-host',jobs:true,binaryArtifacts:true});
  const external=await fixture(t,{options:{pluginHost:suppliedHost,plugins:[]}}); assert.equal((await external.client.getBinaryArtifactCapabilities()).enabled,false);
});

test('binary capture preserves protected paths, hardlink/junction guards and the size bound', async t => {
  const f=await fixture(t,{bytes:Buffer.from([0,255])}),workspace=await createNodeWorkspace({root:f.root,binaryArtifacts:true}); t.after(()=>workspace.dispose());
  const plain=await createNodeWorkspace({root:f.root}); t.after(()=>plain.dispose()); assert.equal(plain.captureBinaryFile,undefined);
  await fs.writeFile(path.join(f.root,'.env'),'fixture');
  for(const name of ['../trace.bin','.env','.git/config','/absolute.bin']) await assert.rejects(workspace.captureBinaryFile(name),{code:'unsafe_path'});
  await fs.link(path.join(f.root,'trace.bin'),path.join(f.root,'linked.bin'));
  await assert.rejects(workspace.captureBinaryFile('linked.bin'),{code:'unsafe_path'});
  await fs.unlink(path.join(f.root,'linked.bin'));
  const outside=path.join(f.directory,'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside,'trace.bin'),'outside');
  await fs.symlink(outside,path.join(f.root,'junction'),'junction'); await assert.rejects(workspace.captureBinaryFile('junction/trace.bin'),{code:'unsafe_path'});
  assert.equal(await fs.readFile(path.join(outside,'trace.bin'),'utf8'),'outside');
  const huge=await fs.open(path.join(f.root,'huge.bin'),'w'); await huge.truncate(BINARY_ARTIFACT_LIMITS.fileBytes+1); await huge.close();
  await assert.rejects(workspace.captureBinaryFile('huge.bin'),{code:'budget_exceeded'});
  await fs.unlink(path.join(f.root,'huge.bin'));
});

test('changing or replacing a registered source rejects subsequent chunks and stale download references', async t => {
  const f=await fixture(t,{bytes:Buffer.from([0,255,128,2])}),job=await f.start(),reference=await f.client.getJobBinaryArtifact(job.jobId,'trace');
  await fs.writeFile(path.join(f.root,'trace.bin'),Buffer.from([0,255,128,3]));
  await assert.rejects(f.client.readJobBinaryArtifactChunk(reference,0),{code:'conflict'});
  const destination=path.join(f.downloads,'changed.bin'); await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination}),{code:'conflict'});
  await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  await assert.rejects(f.client.readJobBinaryArtifactChunk({...reference,scope:{...reference.scope,sessionId:randomUUID()}},0),{code:'generation_mismatch'});
  await assert.rejects(f.client.readJobBinaryArtifactChunk({...reference,artifact:{...reference.artifact,revision:'c'.repeat(64)}},0),{code:'conflict'});
  const other=await fixture(t,{bytes:Buffer.from([1,2])}),otherJob=await other.start(),otherRef=await other.client.getJobBinaryArtifact(otherJob.jobId,'trace');
  await fs.rename(path.join(other.root,'trace.bin'),path.join(other.root,'original.bin')); await fs.writeFile(path.join(other.root,'trace.bin'),Buffer.from([1,2]));
  await assert.rejects(other.client.readJobBinaryArtifactChunk(otherRef,0),{code:'conflict'});
});

test('a chunk with a forged valid chunk checksum still fails whole-file verification', async t => {
  const f=await fixture(t,{bytes:bytesFor(131_079),transport:async(url,options)=>{
    const response=await fetch(url,options),request=JSON.parse(options.body);
    if(request.method!=='artifacts.read'||request.params.offset!==0)return response;
    const reply=await response.json(),bytes=Buffer.from(reply.result.data,'base64'); bytes[0]^=1;
    reply.result.data=bytes.toString('base64'); reply.result.sha256=sha(bytes); return Response.json(reply);
  }}),job=await f.start(),reference=await f.client.getJobBinaryArtifact(job.jobId,'trace'),destination=path.join(f.downloads,'forged.bin');
  await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination}),{code:'conflict'}); await assert.rejects(fs.stat(destination),{code:'ENOENT'});
});

test('a locally modified staging file is never published even after the last progress callback', async t => {
  const f=await fixture(t,{bytes:bytesFor(80_001)}),job=await f.start(),reference=await f.client.getJobBinaryArtifact(job.jobId,'trace'),destination=path.join(f.downloads,'local-change.bin');
  await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination,onProgress:update=>{
    if(update.receivedBytes!==update.totalBytes)return;
    const fd=openSync(`${destination}.dds-part`,'r+'); try {writeSync(fd,Buffer.from([0]),0,1,0);} finally {closeSync(fd);}
  }}),{code:'conflict'}); await assert.rejects(fs.stat(destination),{code:'ENOENT'});
});

test('the client rejects mismatched response scope, artifact, offsets, EOF and chunk checksum', async t => {
  let change;
  const f=await fixture(t,{bytes:Buffer.from([0,128,255]),transport:async(url,options)=>{
    const response=await fetch(url,options); if(JSON.parse(options.body).method!=='artifacts.read'||!change)return response;
    const reply=await response.json(); change(reply.result); return Response.json(reply);
  }}),job=await f.start(),reference=await f.client.getJobBinaryArtifact(job.jobId,'trace');
  for(const mutation of [result=>{result.scope.sessionId=randomUUID();},result=>{result.artifact.id='other';},result=>{result.artifact.path='other.bin';},result=>{result.offset=1;},result=>{result.eof=false;},result=>{result.sha256='c'.repeat(64);},result=>{result.data='QR==';}]) {
    change=mutation; await assert.rejects(f.client.readJobBinaryArtifactChunk(reference,0),{code:'invalid_request'});
  }
  change=undefined; assert.equal((await f.client.readJobBinaryArtifactChunk(reference,0)).nextOffset,3);
});

test('legacy hosts do not receive unknown probes and unsupported binary access never falls back to text reads', async t => {
  const seen=[];
  const f=await fixture(t,{transport:async(url,options)=>{
    const request=JSON.parse(options.body); seen.push(request.method); const response=await fetch(url,options);
    if(request.method!=='hello')return response; const reply=await response.json(); reply.result.hostVersion='0.6.0'; return Response.json(reply);
  }});
  assert.equal((await f.client.getBinaryArtifactCapabilities()).enabled,false);
  await assert.rejects(f.client.listJobBinaryArtifacts(randomUUID()),{code:'unsupported'});
  assert.deepEqual(seen,['hello']);
});

test('capability errors stay visible, while an explicitly unsupported custom host reports disabled', async t => {
  const base=await fixture(t,{bytes:Buffer.alloc(0)});
  for(const code of ['unsupported','permission_denied','authentication_required','invalid_request']) {
    const client=createWorkspaceClient({url:base.server.url,token,fetch:async(_url,options)=>{
      const request=JSON.parse(options.body),hello=base.server.hello();
      return Response.json(request.method==='hello'?{version:1,requestId:request.requestId,ok:true,result:{...hello,hostId:'custom-host'}}:{version:1,requestId:request.requestId,ok:false,error:{code,message:'Fixture failure'}});
    }}); t.after(()=>client.dispose()); await client.connect();
    if(code==='unsupported')assert.equal((await client.getBinaryArtifactCapabilities()).enabled,false);
    else await assert.rejects(client.getBinaryArtifactCapabilities(),{code});
    if(code==='authentication_required')assert.equal(client.binding,undefined);
  }
});

test('staging hardlinks and a junction download parent are refused without touching their targets', async t => {
  const f=await fixture(t,{bytes:Buffer.from([0,255])}),job=await f.start(),reference=await f.client.getJobBinaryArtifact(job.jobId,'trace');
  const victim=path.join(f.directory,'keep.bin'); await fs.writeFile(victim,'keep'); const destination=path.join(f.downloads,'unsafe.bin');
  await fs.link(victim,`${destination}.dds-part`);
  await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination,resume:true}),{code:'unsafe_path'}); assert.equal(await fs.readFile(victim,'utf8'),'keep');
  const linked=path.join(f.directory,'linked-downloads'); await fs.symlink(f.downloads,linked,'junction');
  await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination:path.join(linked,'target.bin')}),{code:'unsafe_path'});
  await assert.rejects(fs.stat(path.join(f.downloads,'target.bin')),{code:'ENOENT'});
});

test('disconnect or total deadline during transfer releases the destination and keeps only partial bytes', async t => {
  const gate=deferred(); let block=false;
  const f=await fixture(t,{bytes:bytesFor(70_003),transport:async(url,options)=>{
    const request=JSON.parse(options.body);
    if(block&&request.method==='artifacts.read') {gate.resolve(); await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}
    return fetch(url,options);
  }}),job=await f.start(),reference=await f.client.getJobBinaryArtifact(job.jobId,'trace'),destination=path.join(f.downloads,'interrupted.bin');
  block=true;
  const pending=downloadJobBinaryArtifact(f.client,reference,{destination}); const rejected=assert.rejects(pending,{code:'disposed'});
  await gate.promise; f.client.disconnect(); await rejected; await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  await f.client.connect(); await assert.rejects(downloadJobBinaryArtifact(f.client,reference,{destination,resume:true,timeoutMs:30}),{code:'budget_exceeded'});
  block=false; assert.equal((await downloadJobBinaryArtifact(f.client,reference,{destination,resume:true})).verified,true);
});

test('binary and text artifacts share job capacity and IDs, and command disposal revokes reads', async t => {
  const f=await fixture(t,{bytes:Buffer.from([1,2,3])}),workspace=await createNodeWorkspace({root:f.root,binaryArtifacts:true}); t.after(()=>workspace.dispose());
  let reporter;
  const host=createPluginHost({jobs:true,binaryArtifacts:true,workspace,grants:['workspace.read']}); t.after(()=>host.dispose());
  await host.activate(definePlugin(manifest,ctx=>ctx.registerCommand({id:'analyze',title:'Analyze'},async(_,{job})=>{
    reporter=job; await job.addBinaryArtifact({id:'same',path:'trace.bin'});
    await assert.rejects(job.addArtifact({id:'same',path:'trace.bin'}),{code:'conflict'});
    for(let n=1;n<16;n++)await job.addBinaryArtifact({id:`trace-${n}`,path:'trace.bin'});
    await assert.rejects(job.addBinaryArtifact({id:'extra',path:'trace.bin'}),{code:'budget_exceeded'}); return null;
  })));
  const job=host.startCommandJob(manifest.id,'analyze',{}, {jobId:randomUUID()}); const deadline=Date.now()+5000;
  while(host.getJob(job.jobId).state==='running'){if(Date.now()>deadline)throw Error('Job did not finish');await delay(5);}
  assert.equal(host.getJob(job.jobId).state,'succeeded'); assert.equal(host.listJobBinaryArtifacts(job.jobId).artifacts.length,16);
  await assert.rejects(reporter.addBinaryArtifact({id:'late',path:'trace.bin'}),{code:'cancelled'});
  host.deactivate(manifest.id); assert.throws(()=>host.listJobBinaryArtifacts(job.jobId),{code:'disposed'});
});

test('binary read concurrency is bounded independently of the HTTP request limit', async t => {
  const gate=deferred(),entered=deferred(); let calls=0;
  const source={path:'trace.bin',revision:sha(Buffer.alloc(0)),byteLength:0,async readChunk(){if(++calls===4)entered.resolve();await gate.promise;return{offset:0,nextOffset:0,eof:true,data:'',sha256:sha(Buffer.alloc(0))};}};
  const f=await fixture(t,{bytes:Buffer.alloc(0),options:{workspace:{capabilities:{read:true,write:false,manage:false},captureBinaryFile:async()=>source}}});
  t.after(()=>gate.resolve()); const job=await f.start(),reference=await f.client.getJobBinaryArtifact(job.jobId,'trace');
  const active=Array.from({length:4},()=>f.client.readJobBinaryArtifactChunk(reference,0)); await entered.promise;
  await assert.rejects(f.client.readJobBinaryArtifactChunk(reference,0),{code:'budget_exceeded'}); assert.equal(calls,4);
  gate.resolve(); assert.equal((await Promise.all(active)).length,4);
});
