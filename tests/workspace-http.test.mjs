import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createWorkspaceServer,createProcessBackend} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';
import {definePlugin} from '../src/index.mjs';
import examplePlugin from '../examples/user-workspace/plugin.mjs';
const token='a'.repeat(64),uuid='a784ff42-e986-47b1-9140-b10f8ba68ca8',hash='b'.repeat(64);
const notice={id:'test-notice',version:'1',text:'Fixture operator notice'};
const manifest={...examplePlugin.manifest,id:'test.workspace'};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-workspace-http-'));
  await fs.writeFile(path.join(root,'design.sv'),'module design; endmodule\n');
  const server=await createWorkspaceServer({root,workspaceId:uuid,token,notice,...options});
  const client=createWorkspaceClient({url:server.url,token});
  t.after(async()=>{client.dispose();await server.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'dds-workspace-http-')));await fs.rm(root,{recursive:true});});
  return{root,server,client};
}
async function raw(server,method,params={},extra={}){
  const response=await fetch(server.url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({version:1,requestId:crypto.randomUUID(),method,params,...(method==='hello'?{}:{workspaceId:uuid,generation:server.generation}),...extra})});
  return response.json();
}
test('real HTTP authentication, origins, scope, generation and JSON content type fail closed',async t=>{
  const {server,client}=await fixture(t);assert.equal((await client.connect()).workspace.id,uuid);
  const unauth=await fetch(server.url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauth.status,401);
  const wrong=await fetch(server.url,{method:'POST',headers:{authorization:`Bearer ${'c'.repeat(64)}`,'content-type':'application/json'},body:'{}'});assert.equal(wrong.status,401);
  const origin=await fetch(server.url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',origin:'null'},body:'{}'});assert.equal(origin.status,403);
  const type=await fetch(server.url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'text/plain'},body:'{}'});assert.equal(type.status,415);
  assert.equal((await raw(server,'fs.read',{path:'design.sv'},{workspaceId:crypto.randomUUID()})).error.code,'workspace_mismatch');
  assert.equal((await raw(server,'fs.read',{path:'design.sv'},{generation:crypto.randomUUID()})).error.code,'generation_mismatch');
  const oversize=await fetch(server.url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:' '.repeat(1_600_001)});assert.equal(oversize.status,413);
});
test('actual user-host plugin edits file and invokes fixed real tool process',async t=>{
  const tool=fileURLToPath(new URL('../examples/user-workspace/tool.mjs',import.meta.url));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-workspace-http-example-'));
  await fs.writeFile(path.join(root,'design.sv'),'module design; endmodule\n');
  const server=await createWorkspaceServer({root,workspaceId:uuid,token,notice,plugins:[{plugin:examplePlugin,artifactSha256:hash,licenseText:'Apache-2.0 fixture'}],grants:['workspace.read','workspace.write','backend.invoke'],backends:{'module-counter':createProcessBackend({executable:process.execPath,args:[tool],cwd:root,env:{}})}});
  const client=createWorkspaceClient({url:server.url,token});
  t.after(async()=>{client.dispose();await server.close();assert.ok(root.startsWith(path.join(os.tmpdir(),'dds-workspace-http-example-')));await fs.rm(root,{recursive:true});});
  const hello=await client.connect();assert.equal(hello.plugins[0].licenseText,'Apache-2.0 fixture');assert.equal(hello.plugins[0].commands.find(value=>value.id==='list').parameters,undefined);
  const inspect=await client.runCommand(examplePlugin.manifest.id,'inspect',{path:'design.sv'},hash);assert.equal(inspect.tool.modules,1);assert.notEqual(inspect.tool.pid,process.pid);
  await client.runCommand(examplePlugin.manifest.id,'append-note',{path:'design.sv'},hash);assert.match(await fs.readFile(path.join(root,'design.sv'),'utf8'),/Edited by a plugin/);
  assert.equal((await client.listPlugins()).plugins.length,1);assert.equal((await client.runCommand(examplePlugin.manifest.id,'list','arbitrary JSON',hash))[0].path,'design.sv');
  await assert.rejects(client.runCommand(examplePlugin.manifest.id,'inspect',{path:'design.sv'},'c'.repeat(64)),{code:'plugin_mismatch'});assert.equal(client.binding,undefined);
});
test('real HTTP file CAS conflict and operator read-only boundary',async t=>{
  const {client}=await fixture(t);await client.connect();const first=await client.readFile('design.sv');
  await client.writeFile(first.path,'changed',first.revision);await assert.rejects(client.writeFile(first.path,'stale',first.revision),{code:'conflict'});
  const readonly=await fixture(t,{writable:false});assert.equal((await readonly.client.connect()).capabilities.write,false);await assert.rejects(readonly.client.writeFile('new.sv','x',null),{code:'permission_denied'});
});
test('HTTP cancel, disconnect and deadline abort owned provider work',async t=>{
  for(const mode of ['cancel','disconnect','timeout']){
    const started=deferred(),stopped=deferred();
    const plugin=definePlugin(manifest,ctx=>{ctx.registerCommand({id:'wait',title:'Wait'},(_input,{signal})=>new Promise(resolve=>{signal.addEventListener('abort',()=>{stopped.resolve();resolve({late:true});},{once:true});started.resolve();}));});
    const {server,client}=await fixture(t,{plugins:[{plugin,artifactSha256:hash}],timeoutMs:mode==='timeout'?100:5_000});await client.connect();
    const controller=new AbortController();const operation=client.runCommand(manifest.id,'wait',{},hash,{signal:controller.signal});
    await started.promise;
    if(mode==='cancel')controller.abort();else if(mode==='disconnect')client.disconnect();
    await assert.rejects(operation,failure=>['cancelled','disposed','budget_exceeded'].includes(failure.code));
    await Promise.race([stopped.promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`Provider ${mode} did not stop`)),1_000))]);
    assert.equal((await raw(server,'request.cancel',{requestId:'not-owned'})).result.cancelled,false);
  }
});
test('plugin failures and client remote error messages never return secrets',async t=>{
  const plugin=definePlugin(manifest,ctx=>{ctx.registerCommand({id:'fail',title:'Fail'},()=>{throw new Error('bearer-secret /private/root fixture');});});
  const {client}=await fixture(t,{plugins:[{plugin,artifactSha256:hash}]});await client.connect();await assert.rejects(client.runCommand(manifest.id,'fail',{},hash),failure=>failure.code==='provider_failed'&&!failure.message.includes('secret'));
  const mock=createWorkspaceClient({url:'https://host.example',token,fetch:async(_url,options)=>new Response(JSON.stringify({version:1,requestId:JSON.parse(options.body).requestId,ok:false,error:{code:'provider_failed',message:'remote-token-secret'}}),{headers:{'content-type':'application/json'}})});
  await assert.rejects(mock.connect(),failure=>failure.code==='provider_failed'&&!failure.message.includes('secret'));mock.dispose();
});
test('client redirects and late notice hash cannot resurrect a disconnected binding',async t=>{
  const {server}=await fixture(t);
  const redirected=createWorkspaceClient({url:'https://host.example',token,fetch:async()=>new Response('',{status:302,headers:{location:'https://evil.example'}})});await assert.rejects(redirected.connect(),{code:'transport_failed'});redirected.dispose();
  const entered=deferred(),release=deferred(),original=crypto.subtle.digest;
  Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:async(...args)=>{entered.resolve();await release.promise;return original.apply(crypto.subtle,args);}});
  t.after(()=>Object.defineProperty(crypto.subtle,'digest',{configurable:true,value:original}));
  const client=createWorkspaceClient({url:server.url,token});t.after(()=>client.dispose());const connection=client.connect();await entered.promise;client.disconnect();release.resolve();await assert.rejects(connection,{code:'disposed'});assert.equal(client.binding,undefined);
});
