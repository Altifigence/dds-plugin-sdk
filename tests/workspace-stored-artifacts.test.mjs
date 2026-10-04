import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPluginHost,definePlugin} from '../src/index.mjs';
import {createNodeJobStore} from '../src/job-storage-node.mjs';
import {createNodeArtifactStore} from '../src/artifact-storage-node.mjs';
import {createWorkspaceServer,createNodeWorkspace,downloadStoredJobArtifact} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';
import {parseStoredArtifactReference} from '../src/artifact-storage.mjs';
import {decodeBinaryArtifactData} from '../src/artifacts.mjs';
import {deferred} from './fixtures.mjs';

const pin='a'.repeat(64),token='b'.repeat(64),notice={id:'test',version:'1',text:'Stored artifact test'};
const manifest={manifestVersion:2,id:'stored-artifact-test',name:'Stored artifacts',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read'],supportedHosts:['test-host','workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const digest=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,options={}){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'dds-stored-artifacts-'))),root=path.join(directory,'project'),storage=path.join(directory,'store'),downloads=path.join(directory,'downloads'),workspaceId=randomUUID();
  await fs.mkdir(root);await fs.mkdir(downloads);const bytes=Buffer.alloc(196731,173),text='Verified text 보관 결과\n';await fs.writeFile(path.join(root,'trace.bin'),bytes);await fs.writeFile(path.join(root,'report.txt'),text);
  const jobs=[],stores=[],servers=[],clients=[];let calls=0;
  async function open({snapshots=true,...extra}={}){
    const jobStore=await createNodeJobStore({directory:storage,workspaceRoot:root,workspaceId}),artifacts=await createNodeArtifactStore({jobStore,...options.artifactOptions});jobs.push(jobStore);stores.push(artifacts);
    const plugin=definePlugin(manifest,c=>c.registerCommand({id:'run',title:'Run'},async(_,{job})=>{calls++;await job.addArtifact({id:'text',path:'report.txt',label:'label not persisted'});await job.addBinaryArtifact({id:'binary',path:'trace.bin'});return{done:true};}));
    const server=await createWorkspaceServer({root,workspaceId,token,notice,jobs:true,binaryArtifacts:true,grants:['workspace.read'],plugins:[{plugin,artifactSha256:pin}],jobStorage:{store:jobStore,...(snapshots?{artifacts}:{})},...extra});servers.push(server);
    const client=createWorkspaceClient({url:server.url,token,...(options.transport?{fetch:options.transport}:{})});clients.push(client);await client.connect();return{jobStore,artifacts,server,client,async close(){client.dispose();await server.close();await artifacts.close();await jobStore.close();}};
  }
  t.after(async()=>{for(const c of clients)c.dispose();for(const s of servers)await s.close().catch(()=>{});for(const s of stores)await s.close();for(const j of jobs)await j.close().catch(()=>{});assert.equal(await fs.realpath(directory),directory);assert.ok(path.basename(directory).startsWith('dds-stored-artifacts-'));await fs.rm(directory,{recursive:true});});
  return{root,storage,downloads,workspaceId,bytes,text,open,calls:()=>calls};
}
async function completed(client,id){const deadline=Date.now()+5000;for(;;){const result=await client.recoverJob(manifest.id,id,pin);if(result.record?.settled)return result;if(Date.now()>deadline)throw Error('Job did not settle');await delay(5);}}
async function start(client){const id=randomUUID();await client.startCommandJob(manifest.id,'run',{},pin,{jobId:id});const r=await completed(client,id);assert.equal(r.record.snapshot.state,'succeeded',JSON.stringify(r));return id;}

test('text and binary snapshots survive source deletion and server restart with newly authorized references',async t=>{
  const f=await fixture(t),first=await f.open();assert.equal((await first.client.getArtifactStorageCapabilities()).enabled,true);const id=await start(first.client);
  const list=await first.client.listStoredJobArtifacts(manifest.id,id,pin);assert.equal(list.artifacts.length,2);assert.ok(list.artifacts.every(a=>a.storage==='snapshot'&&a.availability==='retained'&&a.artifact.label===undefined));
  const reference=await first.client.getStoredJobArtifact(manifest.id,id,'binary',pin),textRef=await first.client.getStoredJobArtifact(manifest.id,id,'text',pin);assert.equal(parseStoredArtifactReference(reference).storage,'snapshot');
  assert.equal((await first.client.readStoredJobArtifactText(textRef)).content,f.text);
  const history=await first.client.listJobHistory(manifest.id,pin);assert.equal(history.items[0].resultAvailability,'snapshot-references');assert.equal(history.items[0].snapshotCount,2);
  await fs.unlink(path.join(f.root,'report.txt'));await fs.unlink(path.join(f.root,'trace.bin'));
  await assert.rejects(first.client.readJobArtifact(id,'text'),{code:'unavailable'});
  await first.close();const second=await f.open();
  await assert.rejects(second.client.readStoredJobArtifactChunk(reference,0),{code:'generation_mismatch'});
  const fresh=await second.client.getStoredJobArtifact(manifest.id,id,'binary',pin);assert.notEqual(fresh.scope.sessionId,reference.scope.sessionId);assert.equal(fresh.snapshot.snapshotId,reference.snapshot.snapshotId);
  const destination=path.join(f.downloads,'trace.bin'),receipt=await downloadStoredJobArtifact(second.client,fresh,{destination});assert.equal(receipt.storage,'snapshot');assert.equal(receipt.verified,true);assert.equal(receipt.snapshotId,fresh.snapshot.snapshotId);assert.deepEqual(await fs.readFile(destination),f.bytes);assert.equal(f.calls(),1);
  const freshText=await second.client.getStoredJobArtifact(manifest.id,id,'text',pin);assert.equal((await second.client.readStoredJobArtifactText(freshText)).content,f.text);
});

test('a cancelled snapshot download resumes across restart with rehashed local bytes and no new execution',async t=>{
  const offsets=[];const f=await fixture(t,{transport:async(url,options)=>{const r=JSON.parse(options.body);if(r.method==='snapshots.read')offsets.push(r.params.offset);return fetch(url,options);}}),first=await f.open(),id=await start(first.client),reference=await first.client.getStoredJobArtifact(manifest.id,id,'binary',pin),destination=path.join(f.downloads,'resumed.bin'),controller=new AbortController();
  await assert.rejects(downloadStoredJobArtifact(first.client,reference,{destination,signal:controller.signal,onProgress:p=>{if(p.receivedBytes>=65536)controller.abort();}}),{code:'cancelled'});
  assert.equal((await fs.stat(destination+'.dds-part')).size,65536);await first.close();await fs.writeFile(path.join(f.root,'trace.bin'),'replacement source');
  const second=await f.open(),fresh=await second.client.getStoredJobArtifact(manifest.id,id,'binary',pin);offsets.length=0;
  const receipt=await downloadStoredJobArtifact(second.client,fresh,{destination,resume:true});assert.equal(receipt.resumedBytes,65536);assert.equal(offsets[0],65536);assert.deepEqual(await fs.readFile(destination),f.bytes);assert.equal(f.calls(),1);
  const corrupt=path.join(f.downloads,'corrupt.bin');await fs.writeFile(corrupt+'.dds-part',Buffer.alloc(13));await assert.rejects(downloadStoredJobArtifact(second.client,fresh,{destination:corrupt,resume:true}),{code:'conflict'});await assert.rejects(fs.stat(corrupt),{code:'ENOENT'});
});

test('operator removal, missing files and expiry are explicit and never fall back to the workspace source',async t=>{
  const f=await fixture(t),s=await f.open(),id=await start(s.client),ref=await s.client.getStoredJobArtifact(manifest.id,id,'binary',pin);
  await s.artifacts.remove(ref.snapshot);const list=await s.client.listStoredJobArtifacts(manifest.id,id,pin);assert.equal(list.artifacts.find(a=>a.artifact.id==='binary').availability,'missing');await assert.rejects(s.client.getStoredJobArtifact(manifest.id,id,'binary',pin),{code:'unavailable'});
  const text=await s.client.getStoredJobArtifact(manifest.id,id,'text',pin);await fs.unlink(path.join(f.storage,'artifacts',text.snapshot.snapshotId+'.bin'));
  await assert.rejects(s.client.readStoredJobArtifactText(text),{code:'unavailable'});assert.equal((await s.client.listStoredJobArtifacts(manifest.id,id,pin)).artifacts.find(a=>a.artifact.id==='text').availability,'missing');assert.equal(await fs.readFile(path.join(f.root,'report.txt'),'utf8'),f.text);
});

test('new permissions, plugin pins and store/workspace identity are required for old snapshots',async t=>{
  const f=await fixture(t),first=await f.open(),id=await start(first.client),ref=await first.client.getStoredJobArtifact(manifest.id,id,'binary',pin);await first.close();
  const denied=await f.open({grants:[]});await assert.rejects(denied.client.getStoredJobArtifact(manifest.id,id,'binary',pin),{code:'permission_denied'});await denied.close();
  const current=await f.open(),fresh=await current.client.getStoredJobArtifact(manifest.id,id,'binary',pin);
  for(const changed of [{storeId:randomUUID()},{workspaceIdentity:'d'.repeat(64)},{pluginArtifactSha256:'d'.repeat(64)}])await assert.rejects(current.client.readStoredJobArtifactChunk({...fresh,snapshot:{...fresh.snapshot,...changed}},0));
  assert.equal(f.calls(),1);assert.equal(ref.snapshot.artifact.revision,digest(f.bytes));
});

test('retained bytes are an explicit opt-in and source references remain distinguishable',async t=>{
  const f=await fixture(t),s=await f.open({snapshots:false});assert.equal((await s.client.getArtifactStorageCapabilities()).enabled,false);await assert.rejects(s.client.listStoredJobArtifacts(manifest.id,randomUUID(),pin),{code:'unsupported'});
  const id=await start(s.client);await s.close();const current=await f.open(),list=await current.client.listStoredJobArtifacts(manifest.id,id,pin);
  assert.ok(list.artifacts.every(a=>a.storage==='source'&&a.availability==='source-reference'&&a.snapshot===null));await assert.rejects(current.client.getStoredJobArtifact(manifest.id,id,'binary',pin),{code:'unavailable'});
});

test('an expired snapshot denies the next chunk while explicit pruning reports retained job pins',async t=>{
  const f=await fixture(t),s=await f.open(),id=await start(s.client),ref=await s.client.getStoredJobArtifact(manifest.id,id,'binary',pin),release=s.jobStore.pin(id),clock=Date.now;
  Date.now=()=>ref.snapshot.expiresAt+1;
  try{
    const list=await s.client.listStoredJobArtifacts(manifest.id,id,pin);assert.equal(list.artifacts.find(a=>a.artifact.id==='binary').availability,'expired');
    await assert.rejects(s.client.readStoredJobArtifactChunk(ref,0),{code:'unavailable'});const pruned=await s.artifacts.prune();assert.ok(pruned.retained.includes(ref.snapshot.snapshotId));
  }finally{Date.now=clock;release();}
});

test('deactivation during a stored read revokes the reply and current command authority',async t=>{
  const f=await fixture(t),s=await f.open(),id=await start(s.client);await s.server.close();
  const workspace=await createNodeWorkspace({root:f.root,binaryArtifacts:true}),gate=deferred(),entered=deferred();t.after(()=>workspace.dispose());
  const controlled={...s.artifacts,async readChunk(...args){entered.resolve();await gate.promise;return s.artifacts.readChunk(...args);}};
  const host=createPluginHost({jobs:true,binaryArtifacts:true,workspace,scope:{projectId:f.workspaceId,sessionId:randomUUID()},grants:['workspace.read'],jobStorage:{store:s.jobStore,artifacts:controlled,workspaceIdentity:s.jobStore.identity.workspaceIdentity,pluginArtifacts:{[manifest.id]:pin}}});t.after(()=>host.dispose());
  await host.activate(definePlugin(manifest,c=>c.registerCommand({id:'run',title:'Run'},()=>null)));
  const ref=await host.getStoredJobArtifact(manifest.id,id,'binary'),read=host.readStoredJobArtifactChunk(ref,0,65536);await entered.promise;host.deactivate(manifest.id);gate.resolve();await assert.rejects(read,{code:'disposed'});
});
