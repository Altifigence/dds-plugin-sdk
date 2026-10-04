import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient,createWorkspaceProject} from '../src/workspace-client.mjs';
import {parseWorkspaceRequest,parseWorkspaceMethodResult} from '../src/workspace-protocol.mjs';
import {parseProjectWatchEvent} from '../src/project-watch.mjs';
import {deferred} from './fixtures.mjs';

const token='project-tools-fixture-token-0123456789';
const hash=value=>createHash('sha256').update(value).digest('hex');
const snapshotDigest=snapshot=>hash(JSON.stringify({root:snapshot.root,entries:snapshot.entries,reasons:snapshot.reasons}));
async function fixture(t,{projects={roots:['rtl'],fileSystem:'local'},fetch,files={'rtl/a.sv':'module a; endmodule','rtl/b.sv':'module b; endmodule'},...options}={}){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-http-')));
  for(const [name,content] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),content);}
  const server=await createWorkspaceServer({root,workspaceId:randomUUID(),token,notice:{id:'fixture',version:'1',text:'Disposable project tools fixture'},timeoutMs:30000,...(projects===false?{}:{projects}),...options});
  const requests=[],transport=async(url,request)=>{requests.push(JSON.parse(request.body));return fetch?fetch(url,request,server):globalThis.fetch(url,request);};
  const client=createWorkspaceClient({url:server.url,token,fetch:transport,timeoutMs:30000});await client.connect();
  t.after(async()=>{client.dispose();await server.close();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-project-http-'));await fs.rm(root,{recursive:true});});
  return{root,server,client,requests};
}
async function raw(server,method,params,extra={}){const reply=await fetch(server.url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({version:1,requestId:randomUUID(),workspaceId:server.workspaceId,generation:server.generation,method,params,...extra})});return reply.json();}
async function changed(iterator,predicate){for(let n=0;n<20;n++){const item=await iterator.next();assert.equal(item.done,false);if(predicate(item.value))return item.value;}throw Error('Expected project update');}

test('HTTP project tools discover, paginate, refresh external changes and preserve edit drafts/CAS',async t=>{
  const f=await fixture(t),project=createWorkspaceProject(f.client);t.after(()=>project.dispose());
  const capabilities=await project.getProjectCapabilities();assert.equal(capabilities.enabled,true);assert.deepEqual(capabilities.watch.roots,['rtl']);assert.equal(capabilities.scope.sessionId,f.server.generation);
  assert.deepEqual(Object.keys(f.server.hello().capabilities).sort(),['commands','manage','read','write']);
  const tree=await project.listTree({root:'rtl'});assert.equal(tree.total,2);
  const names=await project.searchFiles({root:'rtl',query:'**/*.SV',mode:'glob',caseSensitive:false});assert.equal(names.total,2);
  const query={root:'rtl',query:'module ',pageSize:1};const page=await project.searchText(query);assert.ok(page.nextCursor);
  const edit=await project.openFile('rtl/a.sv'),original=edit.snapshot,draft=original.content+'\n// local draft';
  const observer=project.watchProject({root:'rtl',include:['**/*.sv'],intervalMs:250,debounceMs:10},{timeoutMs:30000});t.after(()=>observer.return());
  const initial=(await observer.next()).value;assert.equal(initial.cursor,1);
  await fs.writeFile(path.join(f.root,'rtl','a.sv'),'module external; endmodule');
  const event=await changed(observer,x=>x.snapshot.entries.find(e=>e.path==='rtl/a.sv')?.revision===hash('module external; endmodule'));
  assert.notEqual(event.snapshot.revision,page.snapshotRevision);assert.equal(edit.snapshot,original);assert.ok(draft.includes('local draft'));await assert.rejects(edit.save(draft),{code:'conflict'});assert.equal(edit.snapshot,original);
  await project.releaseProjectQuery(page.nextCursor);const refreshed=await project.searchText(query);assert.equal(refreshed.items[0].entry.revision,event.snapshot.entries.find(e=>e.path==='rtl/a.sv').revision);await project.releaseProjectQuery(refreshed.nextCursor);
  await fs.rename(path.join(f.root,'rtl','a.sv'),path.join(f.root,'rtl','moved.sv'));
  await changed(observer,x=>!x.snapshot.entries.some(e=>e.path==='rtl/a.sv')&&x.snapshot.entries.some(e=>e.path==='rtl/moved.sv'));
  assert.equal(edit.snapshot,original);await assert.rejects(edit.reload(),{code:'not_found'});assert.equal(edit.snapshot,original);
  await fs.writeFile(path.join(f.root,'rtl','a.sv'),'recreated');await changed(observer,x=>x.snapshot.entries.find(e=>e.path==='rtl/a.sv')?.revision===hash('recreated'));
  assert.equal(edit.snapshot,original);await observer.return();
  const id=f.requests.find(x=>x.method==='projects.watch.start').params.subscriptionId;assert.equal((await raw(f.server,'projects.watch.next',{subscriptionId:id,after:1,waitMs:1})).error.code,'not_found');
});

test('disabled and known older hosts reject project operations without ambient listing or discovery probes',async t=>{
  const disabled=await fixture(t,{projects:false});assert.equal((await disabled.client.getProjectCapabilities()).enabled,false);await assert.rejects(disabled.client.listTree({root:'rtl'}),{code:'unsupported'});
  assert.throws(()=>disabled.client.watchProject({root:'../outside'}),{code:'unsafe_path'});
  const old=await fixture(t,{fetch:async(url,options,server)=>{const request=JSON.parse(options.body);if(request.method==='hello')return Response.json({version:1,requestId:request.requestId,ok:true,result:{...server.hello(),hostVersion:'0.8.0'}});return fetch(url,options);}});
  assert.equal((await old.client.getProjectCapabilities()).enabled,false);await assert.rejects(old.client.searchText({root:'rtl',query:'module'}),{code:'unsupported'});await assert.rejects(old.client.watchProject({root:'rtl'}).next(),{code:'unsupported'});
  assert.deepEqual(old.requests.map(x=>x.method),['hello']);assert.equal((await old.client.readFile('rtl/a.sv')).content,'module a; endmodule');
});

test('project methods retain auth, generation, exact params and root boundaries',async t=>{
  const f=await fixture(t);await assert.rejects(f.client.listTree({root:''}),{code:'permission_denied'});
  assert.equal((await raw(f.server,'projects.snapshot',{options:{root:'rtl'}},{generation:randomUUID()})).error.code,'generation_mismatch');
  assert.equal((await raw(f.server,'projects.query',{query:{kind:'tree',root:'rtl',extra:true}})).error.code,'invalid_request');
  assert.equal((await raw(f.server,'projects.watch.start',{subscriptionId:randomUUID(),options:{root:'../outside'}})).error.code,'unsafe_path');
  const unauth=createWorkspaceClient({url:f.server.url,token:'wrong-project-tools-fixture-token-0123456789'});t.after(()=>unauth.dispose());await assert.rejects(unauth.connect(),{code:'authentication_required'});
  const id=randomUUID(),first=await raw(f.server,'projects.watch.start',{subscriptionId:id,options:{root:'rtl'}});assert.equal(first.ok,true);
  assert.equal((await raw(f.server,'projects.watch.next',{subscriptionId:id,after:999,waitMs:1})).error.code,'invalid_request');
  assert.equal((await raw(f.server,'projects.watch.next',{subscriptionId:id,after:1,waitMs:1})).ok,true);
  assert.equal((await raw(f.server,'projects.watch.stop',{subscriptionId:id})).result.stopped,true);
  await assert.rejects(createWorkspaceServer({workspace:{},workspaceId:randomUUID(),token,projects:{roots:[''],fileSystem:'local'}}),{code:'invalid_request'});
});

test('idle subscription leases release capacity and active polls preserve their lease',async t=>{
  const f=await fixture(t),ids=[];
  for(let n=0;n<4;n++){const id=randomUUID();ids.push(id);assert.equal((await raw(f.server,'projects.watch.start',{subscriptionId:id,options:{root:'rtl'}})).ok,true);}
  assert.equal((await raw(f.server,'projects.watch.start',{subscriptionId:randomUUID(),options:{root:'rtl'}})).error.code,'budget_exceeded');
  for(const id of ids)assert.equal((await raw(f.server,'projects.watch.stop',{subscriptionId:id})).result.stopped,true);
  const short=await fixture(t,{projects:{roots:['rtl'],fileSystem:'local',leaseMs:500}}),expired=randomUUID();
  assert.equal((await raw(short.server,'projects.watch.start',{subscriptionId:expired,options:{root:'rtl'}})).ok,true);
  await delay(700);assert.equal((await raw(short.server,'projects.watch.next',{subscriptionId:expired,after:1,waitMs:1})).error.code,'not_found');
  const id=randomUUID();assert.equal((await raw(short.server,'projects.watch.start',{subscriptionId:id,options:{root:'rtl'}})).ok,true);
  const poll=await raw(short.server,'projects.watch.next',{subscriptionId:id,after:1,waitMs:1000});assert.equal(poll.ok,true);assert.equal(poll.result.event,null);
  assert.equal((await raw(short.server,'projects.watch.stop',{subscriptionId:id})).result.stopped,true);
});

test('pending reads reject concurrency and cancel/return/revoke/disconnect suppress late events',async t=>{
  const f=await fixture(t),project=createWorkspaceProject(f.client);t.after(()=>project.dispose());
  const observer=project.watchProject({root:'rtl'});await observer.next();const pending=observer.next();await assert.rejects(observer.next(),{code:'conflict'});await observer.return();assert.equal((await pending).done,true);
  const aborted=new AbortController(),cancel=f.client.watchProject({root:'rtl'},{signal:aborted.signal});await cancel.next();const read=cancel.next(),cancelled=assert.rejects(read,{code:'cancelled'});aborted.abort();await cancelled;await cancel.return();
  const revoked=f.client.watchProject({root:'rtl'});await revoked.next();const reading=revoked.next(),denied=assert.rejects(reading,{code:'permission_denied'});f.server.revokeProjects();await denied;await revoked.return();
  await assert.rejects(f.client.searchText({root:'rtl',query:'module'}),{code:'permission_denied'});
  const next=await fixture(t),oldProject=createWorkspaceProject(next.client);t.after(()=>oldProject.dispose());const previous=oldProject.watchProject({root:'rtl'});await previous.next();next.client.disconnect();await next.client.connect();await assert.rejects(previous.next(),{code:'disposed'});assert.throws(()=>oldProject.watchProject({root:'rtl'}),{code:'disposed'});const fresh=next.client.watchProject({root:'rtl'});assert.equal((await fresh.next()).value.cursor,1);await fresh.return();
});

test('client validates project generation, scope, query hash, text matches and snapshot checksums',async t=>{
  const f=await fixture(t),cap=await f.client.getProjectCapabilities(),page=await f.client.searchText({root:'rtl',query:'module'}),snapshot=await f.client.getProjectSnapshot({root:'rtl'});
  const scope={projectId:f.server.workspaceId,sessionId:f.server.generation};
  const corruptions=[
    ['projects.capabilities',{...cap,scope:{...scope,sessionId:randomUUID()}}],
    ['projects.snapshot',{scope,snapshot:{...snapshot,revision:'a'.repeat(64)}}],
    ['projects.query',{scope,page:{...page,queryHash:'b'.repeat(64)}}],
    ['projects.query',{scope,page:{...page,items:page.items.map(x=>({...x,match:{...x.match,snippet:{...x.match.snippet,text:x.match.snippet.text.replace('module','wrong!')}}}))}}],
  ];
  for(const [method,reply] of corruptions){const client=createWorkspaceClient({url:f.server.url,token,fetch:async(_url,options)=>{const request=JSON.parse(options.body);return Response.json({version:1,requestId:request.requestId,ok:true,result:request.method==='hello'?f.server.hello():request.method==='projects.capabilities'&&method!=='projects.capabilities'?cap:reply});}});t.after(()=>client.dispose());await client.connect();await assert.rejects(method==='projects.capabilities'?client.getProjectCapabilities():method==='projects.snapshot'?client.getProjectSnapshot({root:'rtl'}):client.searchText({root:'rtl',query:'module'}),{code:'invalid_request'});}
});

test('client detects cursor/delta continuity loss and delivers an explicit full resync view',async t=>{
  const f=await fixture(t),cap=await f.client.getProjectCapabilities(),base=await f.client.getProjectSnapshot({root:'rtl'}),scope=cap.scope,native=randomUUID();
  const first=parseProjectWatchEvent({version:1,subscriptionId:native,cursor:1,kind:'snapshot',previousRevision:null,snapshot:base,changes:[],reason:null});
  const entry={...base.entries[0],size:7,revision:hash('changed'),fingerprint:hash('changed')},snapshot={...base,entries:[entry,...base.entries.slice(1)]};snapshot.revision=snapshotDigest(snapshot);
  for(const gap of [true,false]){
    const update=parseProjectWatchEvent({version:1,subscriptionId:native,cursor:gap?3:2,kind:'changes',previousRevision:gap?base.revision:'f'.repeat(64),snapshot,changes:[{kind:'changed',path:entry.path,previous:base.entries[0],current:entry}],reason:null});
    const client=createWorkspaceClient({url:f.server.url,token,fetch:async(_url,options)=>{const r=JSON.parse(options.body);let result=r.method==='hello'?f.server.hello():r.method==='projects.capabilities'?cap:r.method==='projects.watch.stop'?{scope,stopped:true}:{scope,subscriptionId:r.params.subscriptionId,after:r.method==='projects.watch.start'?0:r.params.after,event:r.method==='projects.watch.start'?first:update,expiresAt:Date.now()+30000};return Response.json({version:1,requestId:r.requestId,ok:true,result});}});t.after(()=>client.dispose());await client.connect();const observer=client.watchProject({root:'rtl'});await observer.next();const result=(await observer.next()).value;assert.equal(result.kind,'resync');assert.equal(result.reason,gap?'cursor_gap':'revision_mismatch');assert.deepEqual(result.snapshot.entries,snapshot.entries);await observer.return();
  }
});

test('late query responses cannot cross reconnection and cleanup tolerates an uncooperative transport',async t=>{
  const gate=deferred(),entered=deferred();
  const f=await fixture(t,{fetch:async(url,options)=>{const r=JSON.parse(options.body);const reply=await fetch(url,options);if(r.method==='projects.query'){const body=await reply.json();entered.resolve();await gate.promise;return Response.json(body);}return reply;}});
  const pending=f.client.listTree({root:'rtl'}),discarded=assert.rejects(pending,{code:'disposed'});await entered.promise;f.client.disconnect();await f.client.connect();gate.resolve();await discarded;
  const cap=await f.client.getProjectCapabilities(),snapshot=await f.client.getProjectSnapshot({root:'rtl'}),scope=cap.scope;
  const stuck=createWorkspaceClient({url:f.server.url,token,fetch:async(_url,options)=>{const r=JSON.parse(options.body);if(r.method==='projects.watch.stop')return new Promise(()=>{});const result=r.method==='hello'?f.server.hello():r.method==='projects.capabilities'?cap:{scope,subscriptionId:r.params.subscriptionId,after:0,event:{version:1,subscriptionId:randomUUID(),cursor:1,kind:'snapshot',previousRevision:null,snapshot,changes:[],reason:null},expiresAt:Date.now()+30000};return Response.json({version:1,requestId:r.requestId,ok:true,result});}});t.after(()=>stuck.dispose());await stuck.connect();const observer=stuck.watchProject({root:'rtl'});await observer.next();const start=Date.now();await observer.return();assert.ok(Date.now()-start<3000);
});
