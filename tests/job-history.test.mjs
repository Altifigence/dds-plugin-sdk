import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPluginHost,definePlugin} from '../src/index.mjs';
import {createNodeJobStore} from '../src/job-storage-node.mjs';
import {JOB_HISTORY_LIMITS,parseJobHistoryQuery,parseJobHistoryPage} from '../src/job-history.mjs';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';

const pin='a'.repeat(64),token='b'.repeat(64),notice={id:'test',version:'1',text:'Test job history'};
const manifest={manifestVersion:2,id:'history-example',name:'History',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','backend.invoke'],supportedHosts:['test-host','workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const command={id:'run',title:'Run',parameters:[{name:'message',label:'Message',type:'string',required:true}]};
const plugin=handler=>definePlugin(manifest,c=>c.registerCommand(command,handler));
async function fixture(t) {
  const directory=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'dds-job-history-'))),root=path.join(directory,'project'),storage=path.join(directory,'store'),workspaceId=randomUUID();
  await fs.mkdir(root);const stores=[],hosts=[],servers=[],clients=[];
  async function open(options={}){const s=await createNodeJobStore({directory:storage,workspaceRoot:root,workspaceId,...options});stores.push(s);return s;}
  async function host(store,handler=()=>null,options={}){const h=createPluginHost({jobs:true,scope:{projectId:workspaceId,sessionId:randomUUID()},grants:['workspace.read','backend.invoke'],jobStorage:{store,workspaceIdentity:store.identity.workspaceIdentity,pluginArtifacts:{[manifest.id]:pin}},...options});hosts.push(h);await h.activate(plugin(handler));return h;}
  async function server(store,handler=()=>null,options={}){const s=await createWorkspaceServer({root,workspaceId,token,notice,jobs:true,grants:['workspace.read'],plugins:[{plugin:plugin(handler),artifactSha256:pin}],jobStorage:{store},...options});servers.push(s);const c=createWorkspaceClient({url:s.url,token});clients.push(c);await c.connect();return{server:s,client:c};}
  t.after(async()=>{for(const c of clients)c.dispose();for(const s of servers)await s.close().catch(()=>{});for(const h of hosts){h.dispose();await h.flushJobStore().catch(()=>{});}for(const s of stores)await s.close().catch(()=>{});assert.equal(await fs.realpath(directory),directory);assert.ok(path.basename(directory).startsWith('dds-job-history-'));await fs.rm(directory,{recursive:true});});
  return{root,storage,workspaceId,open,host,server};
}
function seed(store,{at=Date.now(),expiresAt=at+60000,jobId=randomUUID(),...extra}={}) {
  return{...store.identity,pluginArtifactSha256:pin,requestSha256:'c'.repeat(64),revision:1,savedAt:at,expiresAt,settled:true,contentPolicy:'metadata-only',grants:['workspace.read'],snapshot:{protocolVersion:1,jobId,scope:{projectId:store.identity.workspaceId,sessionId:randomUUID()},pluginId:manifest.id,commandId:'run',state:'succeeded',result:null,startedAt:at,updatedAt:at,timeoutMs:5000,progress:null,artifacts:[],lastSequence:2},events:[{sequence:1,at,kind:'state',data:{state:'running'}},{sequence:2,at,kind:'state',data:{state:'succeeded'}}],binaryArtifacts:[],...extra};
}
async function settled(host,id){const end=Date.now()+5000;for(;;){await host.flushJobStore();const r=host.recoverJob(manifest.id,id);if(r.record?.settled)return r;if(Date.now()>end)throw Error('Job did not settle');await delay(5);}}
async function recovered(client,id){const end=Date.now()+5000;for(;;){const r=await client.recoverJob(manifest.id,id,pin);if(r.record?.settled)return r;if(Date.now()>end)throw Error('HTTP job did not settle');await delay(5);}}

test('history contracts are exact, bounded and reject accessors without executing them',()=>{
  assert.equal(parseJobHistoryQuery().limit,16);let touched=0;
  assert.throws(()=>parseJobHistoryQuery({get limit(){touched++;return 1;}}));assert.equal(touched,0);
  for(const q of [{limit:0},{limit:33},{from:10,to:1},{state:'interrupted'},{disposition:'missing'},{search:'secret'},{cursor:'not-a-cursor'},{attemptOf:'bad'},{commandId:'x\n'}])assert.throws(()=>parseJobHistoryQuery(q));
});

test('snapshot paging excludes new jobs, skips removed members and marks current expiry',async t=>{
  const f=await fixture(t),store=await f.open(),host=await f.host(store),now=Date.now();
  const records=[];for(let i=0;i<5;i++){const r=seed(store,{at:now-5000+i*100,expiresAt:now+1000});records.push(r);await store.write(r,0);}
  const page=host.listJobHistory(manifest.id,{limit:2});assert.equal(parseJobHistoryPage(page).items.length,2);assert.equal(page.items[0].jobId,records[4].snapshot.jobId);
  const added=seed(store,{at:now+1});await store.write(added,0);await store.remove(records[2].snapshot.jobId,1);
  const second=host.listJobHistory(manifest.id,{limit:2,cursor:page.nextCursor});assert.deepEqual(second.items.map(x=>x.jobId),[records[1].snapshot.jobId,records[0].snapshot.jobId]);assert.equal(second.nextCursor,null);
  assert.throws(()=>host.listJobHistory(manifest.id,{limit:1,cursor:page.nextCursor}),{code:'conflict'});
  const clock=Date.now;Date.now=()=>now+1001;
  try{const expired=host.listJobHistory(manifest.id,{limit:2,cursor:page.nextCursor});assert.ok(expired.items.every(x=>x.disposition==='expired'&&x.resultAvailability==='expired'));assert.equal(host.recoverJob(manifest.id,records[1].snapshot.jobId).disposition,'expired');}
  finally{Date.now=clock;}
  assert.ok(!JSON.stringify(page).includes('requestSha256'));assert.ok(!JSON.stringify(page).includes('sessionId":"'+records[0].snapshot.scope.sessionId));
});

test('filters and pages expose only matching currently authorized commands and package identity',async t=>{
  const f=await fixture(t),store=await f.open(),now=Date.now(),parent=randomUUID();
  const allowed=seed(store,{at:now-20,attemptOf:parent});await store.write(allowed,0);
  await store.write(seed(store,{at:now-10,pluginArtifactSha256:'d'.repeat(64)}),0);
  await store.write(seed(store,{at:now-5,grants:['workspace.read','backend.invoke']}),0);
  const unavailable=seed(store,{at:now-1});unavailable.snapshot.commandId='removed-command';await store.write(unavailable,0);
  const host=await f.host(store,()=>null,{grants:['workspace.read']});
  const page=host.listJobHistory(manifest.id,{state:'succeeded',disposition:'completed',from:now-30,to:now,attemptOf:parent,commandId:'run'});
  assert.deepEqual(page.items.map(x=>x.jobId),[allowed.snapshot.jobId]);
  assert.equal(host.listJobHistory(manifest.id).items.length,1);host.deactivate(manifest.id);assert.throws(()=>host.listJobHistory(manifest.id),{code:'disposed'});
  const denied=await f.host(store,()=>null,{grants:[]});assert.throws(()=>denied.listJobHistory(manifest.id),{code:'permission_denied'});
});

test('cursor snapshots have bounded slots, expiry and host-generation lifetime',async t=>{
  const f=await fixture(t),store=await f.open(),host=await f.host(store);await store.write(seed(store),0);await store.write(seed(store),0);
  const pages=Array.from({length:JOB_HISTORY_LIMITS.snapshots},()=>host.listJobHistory(manifest.id,{limit:1}));
  assert.throws(()=>host.listJobHistory(manifest.id,{limit:1}),{code:'budget_exceeded'});
  const next=await f.host(store);assert.throws(()=>next.listJobHistory(manifest.id,{limit:1,cursor:pages[0].nextCursor}),{code:'conflict'});
  const clock=Date.now;Date.now=()=>pages[0].expiresAt+100;
  try{assert.throws(()=>host.listJobHistory(manifest.id,{limit:1,cursor:pages[0].nextCursor}),{code:'conflict'});assert.ok(host.listJobHistory(manifest.id,{limit:1}));}finally{Date.now=clock;}
});

test('explicit retry uses new input and identity, preserves the parent and is idempotent after restart',async t=>{
  const f=await fixture(t),store=await f.open(),parent=seed(store),calls=[];await store.write(parent,0);
  const host=await f.host(store,input=>{calls.push(input);return{secret:input.message};}),id=randomUUID();
  const [first,second]=await Promise.all([host.retryCommandJob(manifest.id,parent.snapshot.jobId,{message:'new reviewed input'},{jobId:id}),host.retryCommandJob(manifest.id,parent.snapshot.jobId,{message:'new reviewed input'},{jobId:id})]);
  assert.equal(first.jobId,id);assert.equal(second.jobId,id);const done=await settled(host,id);assert.equal(calls.length,1);assert.equal(done.record.attemptOf,parent.snapshot.jobId);assert.equal(done.record.snapshot.result,null);assert.deepEqual(store.get(parent.snapshot.jobId),parent);
  await assert.rejects(host.retryCommandJob(manifest.id,parent.snapshot.jobId,{message:'different'},{jobId:id}),{code:'conflict'});
  await assert.rejects(host.retryCommandJob(manifest.id,parent.snapshot.jobId,{}, {jobId:randomUUID()}),{code:'invalid_contract'});
  await assert.rejects(host.retryCommandJob(manifest.id,parent.snapshot.jobId,{message:'same id'}, {jobId:parent.snapshot.jobId}),{code:'conflict'});
  host.dispose();await host.flushJobStore();await store.close();
  const reopened=await f.open(),fresh=await f.host(reopened,()=>{throw Error('Must not rerun');});
  const replay=await fresh.retryCommandJob(manifest.id,parent.snapshot.jobId,{message:'new reviewed input'},{jobId:id});assert.equal(replay.disposition,'completed');assert.notEqual(replay.scope.sessionId,replay.record.snapshot.scope.sessionId);
  assert.equal(fresh.listJobHistory(manifest.id,{attemptOf:parent.snapshot.jobId}).items[0].jobId,id);
  assert.ok(!(await fs.readFile(path.join(f.storage,'jobs',id+'.json'),'utf8')).includes('new reviewed input'));
});

test('real HTTP history survives a server restart, binds new scope and refuses old generations',async t=>{
  const f=await fixture(t),store=await f.open();let calls=0;
  const first=await f.server(store,()=>{calls++;return null;});assert.equal((await first.client.getJobStorageCapabilities()).enabled,true);
  const id=randomUUID();await first.client.startCommandJob(manifest.id,'run',{message:'original'},pin,{jobId:id});await recovered(first.client,id);const before=await first.client.listJobHistory(manifest.id,pin);
  const oldGeneration=first.server.generation;first.client.dispose();await first.server.close();await store.close();
  const reopened=await f.open(),second=await f.server(reopened,()=>{calls++;return null;});
  const current=await second.client.recoverJob(manifest.id,id,pin);assert.equal(current.disposition,'completed');assert.equal(current.record.snapshot.scope.sessionId,oldGeneration);assert.equal(current.scope.sessionId,second.server.generation);
  assert.equal((await second.client.listJobHistory(manifest.id,pin)).items[0].jobId,id);const retryId=randomUUID();
  await second.client.retryCommandJob(manifest.id,id,{message:'reviewed retry'},pin,{jobId:retryId});await recovered(second.client,retryId);assert.equal(calls,2);
  const repeats=await second.client.retryCommandJob(manifest.id,id,{message:'reviewed retry'},pin,{jobId:retryId});assert.equal(repeats.jobId,retryId);assert.equal(calls,2);
  await assert.rejects(second.client.recoverJob(manifest.id,id,'c'.repeat(64)),{code:'plugin_mismatch'});
  const response=await fetch(second.server.url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({version:1,requestId:randomUUID(),method:'history.list',workspaceId:f.workspaceId,generation:oldGeneration,params:{pluginId:manifest.id,artifactSha256:pin,query:{}}})});assert.equal((await response.json()).error.code,'generation_mismatch');assert.equal(before.scope.sessionId,oldGeneration);
});

test('history is opt-in and a different workspace store cannot be mounted',async t=>{
  const f=await fixture(t),store=await f.open(),disabled=await f.server(store,()=>null,{jobStorage:undefined});
  assert.equal((await disabled.client.getJobStorageCapabilities()).enabled,false);await assert.rejects(disabled.client.listJobHistory(manifest.id,pin),{code:'unsupported'});
  await assert.rejects(f.server(store,()=>null,{workspaceId:randomUUID()}),{code:'conflict'});
  await assert.rejects(f.server(store,()=>null,{jobs:false}),{code:'invalid_request'});
});

test('client discovery preserves older hosts, rejects malformed replies and refreshes on reconnect',async t=>{
  const f=await fixture(t),store=await f.open(),s=await f.server(store);let mode='legacy';const methods=[];
  const client=createWorkspaceClient({url:s.server.url,token,fetch:async(url,options)=>{
    const request=JSON.parse(options.body);methods.push(request.method);
    const response=await fetch(url,options),reply=await response.json();
    if(request.method==='hello'&&mode==='legacy')reply.result.hostVersion='0.7.0';
    if(request.method==='history.capabilities'&&mode==='unsupported')return Response.json({version:1,requestId:request.requestId,ok:false,error:{code:'unsupported',message:'Unsupported'}});
    if(request.method==='history.capabilities'&&mode==='malformed')reply.result.extra=true;
    return Response.json(reply);
  }});t.after(()=>client.dispose());await client.connect();
  assert.equal((await client.getJobStorageCapabilities()).enabled,false);await assert.rejects(client.listJobHistory(manifest.id,pin),{code:'unsupported'});assert.ok(!methods.includes('history.capabilities'));
  mode='unsupported';await client.connect();assert.equal((await client.getJobStorageCapabilities()).enabled,false);
  mode='malformed';await client.connect();await assert.rejects(client.getJobStorageCapabilities(),{code:'invalid_request'});
  mode='normal';assert.equal((await client.getJobStorageCapabilities()).enabled,true);
  const cancelled=new AbortController();cancelled.abort();const before=methods.length;await assert.rejects(client.listJobHistory(manifest.id,pin,{}, {signal:cancelled.signal}),{code:'cancelled'});assert.equal(methods.length,before);
});

test('client validates history scope, store, plugin, filters, counts and recovery bindings',async t=>{
  const f=await fixture(t),store=await f.open(),record=seed(store);await store.write(record,0);const s=await f.server(store);let change;
  const client=createWorkspaceClient({url:s.server.url,token,fetch:async(url,options)=>{
    const response=await fetch(url,options),method=JSON.parse(options.body).method;if(!change||!['history.list','history.recover'].includes(method))return response;
    const reply=await response.json();change(reply.result);return Response.json(reply);
  }});t.after(()=>client.dispose());await client.connect();await client.getJobStorageCapabilities();
  for(const mutation of [r=>{r.scope.sessionId=randomUUID();},r=>{r.storeId=randomUUID();},r=>{r.pluginId='another';},r=>{r.pluginArtifactSha256='d'.repeat(64);},r=>{r.items[0].commandId='another';},r=>{r.items.push(r.items[0]);}]){change=mutation;await assert.rejects(client.listJobHistory(manifest.id,pin,{commandId:'run'}),{code:'invalid_request'});}
  for(const mutation of [r=>{r.scope.projectId=randomUUID();},r=>{r.record.pluginArtifactSha256='d'.repeat(64);},r=>{r.record.workspaceIdentity='d'.repeat(64);},r=>{r.record.snapshot.pluginId='another';}]){change=mutation;await assert.rejects(client.recoverJob(manifest.id,record.snapshot.jobId,pin),{code:'invalid_request'});}
});
