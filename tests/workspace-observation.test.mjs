import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient, createWorkspaceProject, WORKSPACE_OBSERVATION_LIMITS} from '../src/workspace-client.mjs';
import {definePlugin} from '../src/index.mjs';
import {deferred} from './fixtures.mjs';

const token = 'observation-test-token-01234567890123456789', hash = 'b'.repeat(64);
const manifest = {manifestVersion:2,id:'observer-fixture',name:'Observer fixture',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:[],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const observation = {intervalMs: 250};
async function fixture(t, handler, options = {}, hook) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dds-observation-')));
  await fs.writeFile(path.join(root, 'design.sv'), 'module original; endmodule\n');
  const server = await createWorkspaceServer({root,token,workspaceId:randomUUID(),notice:{id:'test',version:'1',text:'Local observation fixture'},jobs:true,plugins:handler ? [{plugin:definePlugin(manifest, ctx => ctx.registerCommand({id:'run',title:'Run'}, handler)),artifactSha256:hash}] : [],...options});
  const requests = [];
  const transport = async (url, init) => {
    const request = JSON.parse(init.body); requests.push({method:request.method, signal:init.signal, params:request.params});
    return hook ? hook({request,init,server,send:()=>fetch(url,init)}) : fetch(url,init);
  };
  const client = createWorkspaceClient({url:server.url,token,fetch:transport}); await client.connect();
  const project = createWorkspaceProject(client);
  t.after(async () => {project.dispose();client.dispose();await server.close();assert.equal(path.dirname(root), await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true});});
  return {root,server,client,project,requests};
}
const start = (client, input = {}, timeoutMs) => client.startCommandJob(manifest.id, 'run', input, hash, {jobId:randomUUID(),...(timeoutMs ? {timeoutMs} : {})});
async function until(check) {for(let i=0;i<200;i++){if(check())return;await delay(10);}throw Error('Fixture condition timed out');}

test('file revisions report initial/create/change/delete without replacing edit snapshots', {timeout:10000}, async t => {
  const {root,project} = await fixture(t);
  const edit = await project.openFile('design.sv'), original = edit.snapshot;
  const files = project.watchFiles(['design.sv','new.txt'], observation);
  const first = (await files.next()).value;
  assert.deepEqual(first, {kind:'initial',path:'design.sv',previousRevision:null,revision:original.revision});
  assert.ok(Object.isFrozen(first));
  assert.deepEqual((await files.next()).value, {kind:'initial',path:'new.txt',previousRevision:null,revision:null});
  await fs.writeFile(path.join(root,'design.sv'),'module changed; endmodule\n');
  const changed = (await files.next()).value;
  assert.equal(changed.kind,'changed');assert.equal(changed.previousRevision,original.revision);assert.notEqual(changed.revision,original.revision);
  await fs.writeFile(path.join(root,'new.txt'),'한글 😃');
  assert.equal((await files.next()).value.kind,'created');
  await fs.unlink(path.join(root,'design.sv'));
  const deleted = (await files.next()).value;
  assert.equal(deleted.kind,'deleted');assert.equal(deleted.revision,null);assert.equal(deleted.previousRevision,changed.revision);
  assert.equal(edit.snapshot,original);assert.equal(edit.state,'ready');
  await assert.rejects(edit.save('preserve my draft'),{code:'conflict'});
  assert.equal(edit.snapshot,original);await files.return();
});

test('file observation is pull-driven, samples coalesced changes and skips equal revisions', {timeout:10000}, async t => {
  let afterSample;
  const {root,project,requests} = await fixture(t,undefined,{writable:false},async({request,send})=>{
    const response=await send();
    if(request.method==='fs.revision')await afterSample?.();
    return response;
  });
  const paths = ['design.sv'];
  const files = project.watchFiles(paths, observation);paths[0]='changed-by-caller.txt';
  const initial = (await files.next()).value;
  const reads = () => requests.filter(r=>r.method==='fs.revision').length;
  await delay(350);assert.equal(reads(),1);
  await fs.writeFile(path.join(root,'design.sv'),'intermediate');
  await fs.writeFile(path.join(root,'design.sv'),'latest');
  const changed = (await files.next()).value;
  assert.equal(changed.kind,'changed');assert.equal(changed.previousRevision,initial.revision);
  assert.equal(changed.revision,(await project.openFile('design.sv')).snapshot.revision);
  const before = reads();let unchanged=0;
  // Change after two completed samples, never during the server's guarded read.
  afterSample=async()=>{if(++unchanged===2)await fs.writeFile(path.join(root,'design.sv'),'final change');};
  const pending = files.next(); pending.catch(()=>{});
  assert.equal((await pending).value.previousRevision,changed.revision);
  assert.ok(reads()>=before+3);
  assert.equal(requests.filter(r=>r.method==='fs.write').length,0);await files.return();
});

test('file watch inputs are inert and bounded before HTTP work', async t => {
  const {project,client,requests} = await fixture(t);
  for (const paths of [[],Array.from({length:17},(_,i)=>`${i}.txt`),['design.sv','design.sv'], 'design.sv']) assert.throws(()=>project.watchFiles(paths),{code:'invalid_request'});
  for (const path of ['../secret','.env','folder\\file.txt','C:/file.txt']) assert.throws(()=>project.watchFiles([path]),{code:'unsafe_path'});
  for (const options of [{intervalMs:1},{intervalMs:60001},{requestTimeoutMs:30001},{timeoutMs:1800001},{timeoutMs:0},{includeInitial:1},{signal:{}},{unknown:true},{get intervalMs(){throw Error('getter executed');}}]) assert.throws(()=>project.watchFiles(['design.sv'],options),{code:'invalid_request'});
  for (const options of [{after:-1},{after:1.5},{after:Number.MAX_SAFE_INTEGER+1}]) assert.throws(()=>client.watchJob(randomUUID(),options),{code:'invalid_request'});
  assert.throws(()=>client.watchJob('not-an-id'),{code:'invalid_request'});
  assert.equal(requests.length,1);
  const abort = new AbortController();abort.abort();
  await assert.rejects(project.watchFiles(['design.sv'],{signal:abort.signal}).next(),{code:'cancelled'});
  assert.equal(requests.length,1);
});

test('includeInitial false establishes a baseline and waits for an actual change', {timeout:10000}, async t => {
  let samples=0;
  const {root,project} = await fixture(t,undefined,{},async({request,send})=>{
    const response=await send();
    if(request.method==='fs.revision'&&++samples===2)await fs.writeFile(path.join(root,'design.sv'),'external change');
    return response;
  });
  const files = project.watchFiles(['design.sv'],{...observation,includeInitial:false});
  const pending=files.next();pending.catch(()=>{});
  assert.equal((await pending).value.kind,'changed');await files.return();
});

test('observer capacity is shared per client, lazy and released by return/dispose', async t => {
  const {project} = await fixture(t);
  const unused=Array.from({length:20},()=>project.watchFiles(['design.sv']));
  const active=[];
  for(let i=0;i<WORKSPACE_OBSERVATION_LIMITS.observers;i++){const watcher=unused[i];await watcher.next();active.push(watcher);}
  await assert.rejects(unused[8].next(),{code:'budget_exceeded'});
  await active[0].return();await unused[9].next();
  project.dispose();
  await assert.rejects(active[1].next(),{code:'disposed'});
});

test('return interrupts a pending read and concurrent next calls do not queue', {timeout:5000}, async t => {
  const {project} = await fixture(t);
  const files=project.watchFiles(['design.sv'],{intervalMs:60000});await files.next();
  const pending=files.next();pending.catch(()=>{});
  await assert.rejects(files.next(),{code:'conflict'});
  assert.equal((await files.return()).done,true);assert.equal((await pending).done,true);assert.equal((await files.next()).done,true);
});

test('AbortSignal, project disposal and connection replacement interrupt idle polling', {timeout:5000}, async t => {
  const {project,client} = await fixture(t);
  const abort=new AbortController();const files=project.watchFiles(['design.sv'],{intervalMs:60000,signal:abort.signal});await files.next();
  const pending=files.next();pending.catch(()=>{});abort.abort();await assert.rejects(pending,{code:'cancelled'});
  const old=project.watchFiles(['design.sv'],{intervalMs:60000});await old.next();await client.connect();
  await assert.rejects(old.next(),{code:'disposed'});assert.throws(()=>project.watchFiles(['design.sv']),{code:'disposed'});
  const fresh=createWorkspaceProject(client), next=fresh.watchFiles(['design.sv'],{intervalMs:60000});await next.next();
  const blocked=next.next();blocked.catch(()=>{});fresh.dispose();await assert.rejects(blocked,{code:'disposed'});
});

test('iterator return aborts an in-flight request and ignores a late transport reply', {timeout:5000}, async t => {
  const entered=deferred(),gate=deferred();let captured;
  const {project}=await fixture(t,undefined,{},async({request,init,send})=>{
    const response=await send();if(request.method==='fs.revision'){captured=init.signal;entered.resolve();await gate.promise;}return response;
  });
  const files=project.watchFiles(['design.sv']);const pending=files.next();pending.catch(()=>{});await entered.promise;
  await files.return();assert.equal(captured.aborted,true);assert.equal((await pending).done,true);
  gate.resolve();await delay(20);assert.equal((await files.next()).done,true);
});

test('protected-file alias errors terminate observation instead of appearing as deletion', async t => {
  const {root,project}=await fixture(t);
  await fs.writeFile(path.join(root,'.git-credentials'),'private fixture');
  await fs.link(path.join(root,'.git-credentials'),path.join(root,'alias.txt'));
  const files=project.watchFiles(['alias.txt']);await assert.rejects(files.next(),{code:'unsafe_path'});
  assert.equal((await files.next()).done,true);
});

test('job observation drains bounded pages and reports expired events before terminal completion', {timeout:10000}, async t => {
  const gate=deferred();let executions=0;
  const {client,requests}=await fixture(t,async(_,{job})=>{executions++;for(let i=0;i<400;i++)job.log('info',`line ${i}`);await gate.promise;return{done:true};});
  const job=await start(client), watch=client.watchJob(job.jobId,observation);
  const first=(await watch.next()).value;assert.ok(first.dropped>0);assert.equal(first.events.length,64);assert.equal(first.hasMore,true);assert.ok(Object.isFrozen(first));
  gate.resolve();const updates=[first];for await(const update of watch)updates.push(update);
  for(let i=1;i<updates.length;i++)assert.equal(updates[i].after,updates[i-1].nextCursor);
  const sequences=updates.flatMap(u=>u.events.map(e=>e.sequence));assert.equal(new Set(sequences).size,sequences.length);
  const last=updates.at(-1);assert.equal(last.snapshot.state,'succeeded');assert.equal(last.hasMore,false);assert.equal(last.nextCursor,last.snapshot.lastSequence);
  assert.equal((await watch.next()).done,true);
  assert.equal((await client.waitForJob(job.jobId,observation)).result.done,true);
  assert.equal(executions,1);assert.equal(requests.filter(r=>r.method==='jobs.start').length,1);assert.equal(requests.filter(r=>r.method==='jobs.cancel').length,0);
});

test('job observer cancellation and explicit reconnect resume never restart or cancel the job', {timeout:10000}, async t => {
  const gate=deferred();let executions=0,aborted=false;
  const {client,requests}=await fixture(t,async(_,{signal,job})=>{executions++;signal.addEventListener('abort',()=>{aborted=true;},{once:true});job.log('info','ready');await gate.promise;return'ok';});
  const job=await start(client),abort=new AbortController();
  const watching=client.watchJob(job.jobId,{intervalMs:60000,signal:abort.signal});const initial=(await watching.next()).value;
  const pending=watching.next();pending.catch(()=>{});abort.abort();await assert.rejects(pending,{code:'cancelled'});
  assert.equal((await client.getJob(job.jobId)).state,'running');assert.equal(aborted,false);
  const paused=client.watchJob(job.jobId,observation);await paused.next();client.disconnect();await client.connect();
  await assert.rejects(paused.next(),{code:'disposed'});
  gate.resolve();const result=await client.waitForJob(job.jobId,{...observation,after:initial.nextCursor});
  assert.equal(result.state,'succeeded');assert.equal(executions,1);assert.equal(aborted,false);
  assert.equal(requests.filter(r=>r.method==='jobs.cancel').length,0);assert.equal(requests.filter(r=>r.method==='jobs.start').length,1);
});

test('waiting returns failed, timed-out and cancelled snapshots rather than executing again', {timeout:10000}, async t => {
  const {client}=await fixture(t,(input,{signal})=>{
    if(input.fail)throw Error('fixture failure');
    return new Promise(resolve=>signal.addEventListener('abort',()=>resolve(null),{once:true}));
  });
  const failed=await start(client,{fail:true});assert.equal((await client.waitForJob(failed.jobId,observation)).state,'failed');
  const timed=await start(client,{},50);assert.equal((await client.waitForJob(timed.jobId,observation)).state,'timed_out');
  const cancelled=await start(client);await client.cancelJob(cancelled.jobId);assert.equal((await client.waitForJob(cancelled.jobId,observation)).state,'cancelled');
});

test('observation deadline stops waiting without cancelling the server command', {timeout:5000}, async t => {
  const {client,requests}=await fixture(t,(_,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(null),{once:true})));
  const job=await start(client);
  await assert.rejects(client.waitForJob(job.jobId,{intervalMs:60000,timeoutMs:50}),{code:'budget_exceeded'});
  assert.equal((await client.getJob(job.jobId)).state,'running');assert.equal(requests.filter(r=>r.method==='jobs.cancel').length,0);
  await client.cancelJob(job.jobId);
});

test('file and job observers share capacity and a paused deadline releases its slot', {timeout:5000}, async t => {
  const {client,project}=await fixture(t,(_,{signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>resolve(null),{once:true})));
  const job=await start(client), active=[];
  for(let i=0;i<7;i++){const files=project.watchFiles(['design.sv']);await files.next();active.push(files);}
  const watching=client.watchJob(job.jobId,{timeoutMs:150});await watching.next();
  await assert.rejects(project.watchFiles(['design.sv']).next(),{code:'budget_exceeded'});
  await delay(200);await assert.rejects(watching.next(),{code:'budget_exceeded'});
  const fresh=project.watchFiles(['design.sv']);assert.equal((await fresh.next()).value.kind,'initial');
  await fresh.return();for(const files of active)await files.return();await client.cancelJob(job.jobId);
});

test('job observation ignores JSON key order but rejects changes without a new sequence', async t => {
  const {client,server}=await fixture(t,()=>({result:'unchanged'}));
  const job=await start(client), snapshot=await client.waitForJob(job.jobId,observation), page=await client.getJobEvents(job.jobId);
  for(const mutate of [false,true]){
    let reads=0;
    const injected=createWorkspaceClient({url:server.url,token,fetch:async(_url,init)=>{
      const request=JSON.parse(init.body);let result;
      if(request.method==='hello')result=server.hello();
      else if(request.method==='jobs.events'){
        const events=page.events.filter(e=>e.sequence>request.params.after).slice(0,1);
        result={...page,after:request.params.after,events,nextCursor:events.at(-1)?.sequence??request.params.after,hasMore:false};
      }else{
        result=reads===0?{...snapshot}:Object.fromEntries(Object.entries(snapshot).reverse());
        result.scope=reads===0?snapshot.scope:Object.fromEntries(Object.entries(snapshot.scope).reverse());
        if(++reads>1&&mutate)result.updatedAt++;
      }
      return Response.json({version:1,requestId:request.requestId,ok:true,result});
    }});t.after(()=>injected.dispose());await injected.connect();
    const watch=injected.watchJob(job.jobId,observation);assert.equal((await watch.next()).value.hasMore,true);
    if(mutate)await assert.rejects(watch.next(),{code:'invalid_request'});
    else {for await(const update of watch)assert.equal(update.snapshot.state,'succeeded');}
  }
});

test('authentication revocation preserves its error and closes the connection', async t => {
  let rejectRead=false;
  const {project,client}=await fixture(t,undefined,{},({request,send})=>request.method==='fs.revision'&&rejectRead?new Response('',{status:401}):send());
  const files=project.watchFiles(['design.sv'],observation);await files.next();rejectRead=true;
  await assert.rejects(files.next(),{code:'authentication_required'});assert.equal(client.binding,undefined);
});

test('job identity changes during terminal-page draining are rejected', async t => {
  const {client,server}=await fixture(t,(_,{job})=>{job.log('info','done');return'ok';});
  const started=await start(client), snapshot=await client.waitForJob(started.jobId,observation), page=await client.getJobEvents(started.jobId);
  let reads=0;
  const injected=createWorkspaceClient({url:server.url,token,fetch:async(_url,init)=>{
    const r=JSON.parse(init.body);let result;
    if(r.method==='hello')result=server.hello();
    else if(r.method==='jobs.events'){
      const events=page.events.filter(e=>e.sequence>r.params.after).slice(0,1);
      result={...page,after:r.params.after,events,nextCursor:events.at(-1)?.sequence??r.params.after,hasMore:false};
    }else result=++reads===1?snapshot:{...snapshot,pluginId:'changed-identity'};
    return Response.json({version:1,requestId:r.requestId,ok:true,result});
  }});t.after(()=>injected.dispose());await injected.connect();
  const watch=injected.watchJob(started.jobId,observation);assert.equal((await watch.next()).value.hasMore,true);
  await assert.rejects(watch.next(),{code:'invalid_request'});
});

test('disabled jobs fail without fallback execution while existing file observation still works', async t => {
  const {client,project,requests}=await fixture(t,undefined,{jobs:false});
  await assert.rejects(client.waitForJob(randomUUID(),observation));
  const files=project.watchFiles(['design.sv']);assert.equal((await files.next()).value.kind,'initial');await files.return();
  assert.ok(!requests.some(r=>['jobs.start','commands.run','jobs.cancel'].includes(r.method)));
});
