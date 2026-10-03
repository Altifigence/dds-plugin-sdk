import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkspaceServer,createProcessBackend} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';
import {createPluginHost,definePlugin} from '../src/index.mjs';
import {deferred} from './fixtures.mjs';

const token='a'.repeat(64),hash='b'.repeat(64),notice={id:'test',version:'1',text:'Fixture notice'};
const manifest={manifestVersion:2,id:'job-plugin',name:'Job plugin',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','workspace.write','backend.invoke'],supportedHosts:['test-host','workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
async function fixture(t,activate,options={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-workspace-jobs-'))),workspaceId=randomUUID();
  const server=await createWorkspaceServer({root,workspaceId,token,notice,jobs:true,plugins:activate?[{plugin:definePlugin(manifest,activate),artifactSha256:hash}]:[],...options});
  const client=createWorkspaceClient({url:server.url,token});await client.connect();
  t.after(async()=>{client.dispose();await server.close();assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true});});
  return{root,workspaceId,server,client};
}
async function waitFor(check) {const deadline=Date.now()+5_000;for(;;){const value=await check();if(value)return value;if(Date.now()>deadline)throw Error('Condition timed out');await delay(10);}}
const terminal=(client,id)=>waitFor(async()=>{const result=await client.getJob(id);return result.state==='running'?null:result;});
const start=(client,input={},jobId=randomUUID())=>client.startCommandJob(manifest.id,'analyze',input,hash,{jobId});
async function raw(server,method,params,extra={}) {
  const response=await fetch(server.url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({version:1,requestId:randomUUID(),method,params,workspaceId:server.workspaceId,generation:server.generation,...extra})});return response.json();
}

test('real HTTP jobs survive client disconnect, reconnect by ID, paginate events and read pinned UTF-8 artifacts',async t=>{
  const gate=deferred();let executions=0;
  const {root,server,client}=await fixture(t,ctx=>ctx.registerCommand({id:'analyze',title:'Analyze'},async(_,{job})=>{executions++;job.log('info','Started');await gate.promise;job.reportProgress({completed:1,total:1});await job.addArtifact({id:'report',path:'report.txt'});return{done:true};}),{grants:['workspace.read']});
  const content='x'.repeat(262_144);await fs.writeFile(path.join(root,'report.txt'),content);
  const hello=server.hello();assert.deepEqual(Object.keys(hello.capabilities).sort(),['commands','manage','read','write']);assert.equal(hello.protocolVersion,1);
  assert.equal((await client.getJobCapabilities()).enabled,true);const initial=await start(client);
  client.disconnect();gate.resolve();await client.connect();const result=await terminal(client,initial.jobId);
  assert.equal(result.state,'succeeded');assert.equal(result.scope.sessionId,server.generation);assert.equal(executions,1);
  assert.equal((await start(client,{},initial.jobId)).state,'succeeded');assert.equal(executions,1);
  const page=await client.getJobEvents(initial.jobId);assert.ok(page.events.some(e=>e.kind==='progress'));assert.equal(page.hasMore,false);
  const file=await client.readJobArtifact(initial.jobId,'report');assert.equal(file.content,content);
  await fs.writeFile(path.join(root,'report.txt'),'changed');await assert.rejects(client.readJobArtifact(initial.jobId,'report'),{code:'conflict'});
});
test('HTTP jobs retain auth, plugin pin, generation and exact request boundaries',async t=>{
  let calls=0;const {server,client}=await fixture(t,ctx=>ctx.registerCommand({id:'analyze',title:'Analyze'},()=>{calls++;return null;}));
  const params={pluginId:manifest.id,commandId:'analyze',input:{},artifactSha256:hash,jobId:randomUUID()};
  assert.equal((await raw(server,'jobs.start',params,{generation:randomUUID()})).error.code,'generation_mismatch');
  assert.equal((await raw(server,'jobs.start',{...params,artifactSha256:'c'.repeat(64)})).error.code,'plugin_mismatch');
  assert.equal((await raw(server,'jobs.start',{...params,timeoutMs:1_800_001})).error.code,'invalid_request');
  assert.equal((await raw(server,'jobs.start',{...params,untrusted:'extra'})).error.code,'invalid_request');
  const unauth=createWorkspaceClient({url:server.url,token:'c'.repeat(64)});await assert.rejects(unauth.connect(),{code:'authentication_required'});unauth.dispose();
  assert.equal(calls,0);const job=await start(client);await terminal(client,job.jobId);
  await assert.rejects(client.startCommandJob(manifest.id,'analyze',{},hash,{jobId:'invalid'}),{code:'invalid_contract'});
  await assert.rejects(start(client,{different:true},job.jobId),{code:'conflict'});assert.equal(calls,1);
  await assert.rejects(client.getJob(randomUUID()),{code:'unavailable'});
});
test('jobs are disabled by default and on a preconfigured host with another scope',async t=>{
  const first=await fixture(t,ctx=>ctx.registerCommand({id:'analyze',title:'Analyze'},()=>42),{jobs:false});
  assert.equal((await first.client.getJobCapabilities()).enabled,false);await assert.rejects(start(first.client),{code:'unsupported'});
  assert.equal(await first.client.runCommand(manifest.id,'analyze',{},hash),42);
  const host=createPluginHost({hostId:'workspace-host',jobs:true});const second=await fixture(t,undefined,{pluginHost:host});
  assert.equal((await second.client.getJobCapabilities()).enabled,false);await assert.rejects(start(second.client),{code:'unsupported'});
});
test('HTTP job cancellation terminates a real fixed process backend',async t=>{
  let backend;
  const {root,client}=await fixture(t,ctx=>ctx.registerCommand({id:'analyze',title:'Analyze'},async(_,{job})=>job.invokeBackend('wait',{})),{grants:['backend.invoke'],backends:{wait:(input,options)=>backend(input,options)}});
  const pidFile=path.join(root,'worker.pid');
  backend=createProcessBackend({executable:process.execPath,args:['-e',"require('node:fs').writeFileSync('worker.pid',String(process.pid));setInterval(()=>{},1000);"],cwd:root,env:{},timeoutMs:60_000});
  const started=await start(client);const pid=await waitFor(async()=>{try{return Number(await fs.readFile(pidFile,'utf8'));}catch{return null;}});
  assert.equal((await client.cancelJob(started.jobId)).state,'cancelled');
  await waitFor(()=>{try{process.kill(pid,0);return false;}catch(failure){if(failure.code==='ESRCH')return true;throw failure;}});
  assert.equal((await client.getJob(started.jobId)).result,undefined);
});
test('server shutdown aborts jobs; a new generation cannot retrieve an old job',async t=>{
  const aborted=deferred();const {root,server,client,workspaceId}=await fixture(t,ctx=>ctx.registerCommand({id:'analyze',title:'Analyze'},(_,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted.resolve();resolve('late');},{once:true}))));
  const job=await start(client);await server.close();await aborted.promise;
  const replacement=await createWorkspaceServer({root,workspaceId,token,notice,jobs:true});t.after(()=>replacement.close());
  const response=await raw(replacement,'jobs.get',{jobId:job.jobId},{generation:server.generation});assert.equal(response.error.code,'generation_mismatch');
});
test('job result identities and artifact hashes are validated by the client',async t=>{
  const {client,server,root}=await fixture(t,ctx=>ctx.registerCommand({id:'analyze',title:'Analyze'},async(_,{job})=>{await job.addArtifact({id:'file',path:'file.txt'});return null;}),{grants:['workspace.read']});
  await fs.writeFile(path.join(root,'file.txt'),'data');const good=await terminal(client,(await start(client)).jobId),artifact=await client.readJobArtifact(good.jobId,'file');
  for(const [method,result] of [['jobs.get',{...good,jobId:randomUUID()}],['jobs.get',{...good,scope:{...good.scope,sessionId:randomUUID()}}],['jobs.artifact',{...artifact,content:'fake'}]]) {
    const injected=createWorkspaceClient({url:server.url,token,fetch:async(_url,options)=>{const request=JSON.parse(options.body);return Response.json({version:1,requestId:request.requestId,ok:true,result:request.method==='hello'?server.hello():result});}});t.after(()=>injected.dispose());await injected.connect();
    await assert.rejects(method==='jobs.artifact'?injected.readJobArtifact(good.jobId,'file'):injected.getJob(good.jobId),{code:'invalid_request'});
  }
});
