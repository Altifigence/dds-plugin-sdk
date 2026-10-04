import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {definePlugin} from '../src/index.mjs';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';
import {uploadFile,EMPTY_UPLOAD_SHA256} from '../src/uploads.mjs';
import {createNodeUploadSource} from '../src/uploads-node.mjs';
import {createBrowserUploadSource} from '../src/uploads-browser.mjs';
import {parseWorkspaceRequest,parseWorkspaceMethodResult} from '../src/workspace-protocol.mjs';
const token='upload-http-test-token-0123456789',pin='b'.repeat(64),id='upload-plugin',hash=x=>createHash('sha256').update(x).digest('hex');
const manifest={manifestVersion:2,id,name:'Upload plugin',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','workspace.write'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
async function fixture(t,{uploads=true,fetch:transport,permissions=manifest.permissions,...config}={}){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-upload-http-'))),root=path.join(directory,'workspace');await fs.mkdir(path.join(root,'input'),{recursive:true});
  const plugin=definePlugin({...manifest,permissions},ctx=>ctx.registerCommand({id:'hello',title:'Hello'},()=>({hello:true}))),requests=[];
  const base={root,workspaceId:randomUUID(),token,notice:{id:'test',version:'1',text:'Disposable upload test'},plugins:[{plugin,artifactSha256:pin}],grants:['workspace.read','workspace.write'],timeoutMs:30000,...(uploads?{uploads:{directory:path.join(directory,'uploads'),principalId:'operator',roots:['input'],fileSystem:'local'}}:{}),...config};
  let server=await createWorkspaceServer(base),client;const clients=[],servers=[server];
  async function connect(){client=createWorkspaceClient({url:server.url,token,timeoutMs:30000,fetch:async(url,options)=>{const request=JSON.parse(options.body);requests.push(request);return transport?transport(url,options,server):fetch(url,options);}});clients.push(client);await client.connect();return client;}
  await connect();t.after(async()=>{for(const c of clients)c.dispose();for(const s of servers.reverse())await s.close();assert.equal(path.dirname(await fs.realpath(directory)),await fs.realpath(os.tmpdir()));assert.ok(path.basename(directory).startsWith('dds-upload-http-'));await fs.rm(directory,{recursive:true});});
  return{directory,root,requests,get server(){return server;},get client(){return client;},async restart(){client.dispose();await server.close();server=await createWorkspaceServer(base);servers.push(server);return connect();}};
}
const selected=(extra={})=>({uploadId:randomUUID(),pluginId:id,artifactSha256:pin,path:'input/input.bin',expectedRevision:null,...extra});
const spec=(data,extra={})=>({...selected(extra),byteLength:data.length,sha256:hash(data)});
const chunk=(data,offset=0)=>({offset,data:Buffer.from(data).toString('base64'),sha256:hash(data)});
test('HTTP upload helper prehashes selected Node bytes, cancels, restarts with fresh grants and commits exact binary',async t=>{
  const f=await fixture(t),data=Buffer.alloc(1024*1024+17,0xbc),sourcePath=path.join(f.directory,'selected.bin');await fs.writeFile(sourcePath,data);const source=await createNodeUploadSource({path:sourcePath}),target=selected(),cancel=new AbortController();
  await assert.rejects(uploadFile(f.client,source,{...target,signal:cancel.signal,onProgress:p=>{if(p.phase==='uploading')cancel.abort();}}),{code:'cancelled'});
  let saved=await f.client.queryUpload({uploadId:target.uploadId,pluginId:id,artifactSha256:pin});assert.equal(saved.offset,65536);assert.deepEqual((await f.client.listFiles('input')).entries,[]);const oldReference=saved.reference;
  await f.restart();await assert.rejects(f.client.writeUploadChunk(oldReference,chunk(data.subarray(65536,131072),65536)),{code:'generation_mismatch'});
  const resumed=await uploadFile(f.client,source,{...target,recover:true});assert.equal(resumed.state,'committed');assert.equal(resumed.commitReceipt.revision,hash(data));assert.equal(hash(await fs.readFile(path.join(f.root,target.path))),hash(data));
  assert.equal(f.requests.filter(r=>r.method==='uploads.write').length,Math.ceil(data.length/65536));assert.equal((await uploadFile(f.client,source,{...target,recover:true})).state,'committed');
  assert.equal((await f.client.runCommand(id,'hello',{},pin)).hello,true);
});
test('HTTP upload lost commit response is queried without re-uploading or claiming rollback',async t=>{
  let lost=false;const f=await fixture(t,{fetch:async(url,options)=>{const response=await fetch(url,options);if(JSON.parse(options.body).method==='uploads.commit'&&!lost){lost=true;await response.json();throw Error('simulated lost response');}return response;}}),file=new File([new Uint8Array([0,2,255])],'chosen.bin'),target=selected();
  await assert.rejects(uploadFile(f.client,createBrowserUploadSource(file),target),{code:'transport_failed'});const result=await f.client.queryUpload({uploadId:target.uploadId,pluginId:id,artifactSha256:pin});assert.equal(result.state,'committed');assert.equal((await uploadFile(f.client,createBrowserUploadSource(file),{...target,recover:true})).state,'committed');assert.equal(f.requests.filter(r=>r.method==='uploads.write').length,1);
});
test('HTTP upload discovery is optional and older hosts receive no new method probes',async t=>{
  const disabled=await fixture(t,{uploads:false});assert.equal((await disabled.client.getUploadCapabilities()).enabled,false);await assert.rejects(disabled.client.beginUpload(spec(Buffer.from('x'))),{code:'unsupported'});
  const old=await fixture(t,{fetch:async(_url,options,server)=>{const request=JSON.parse(options.body);return Response.json({version:1,requestId:request.requestId,ok:true,result:{...server.hello(),hostVersion:'0.9.0'}});}});assert.equal((await old.client.getUploadCapabilities()).enabled,false);await assert.rejects(old.client.beginUpload(spec(Buffer.from('x'))),{code:'unsupported'});assert.deepEqual(old.requests.map(r=>r.method),['hello']);
  assert.equal((await disabled.client.writeFile('input/text.txt','old text API',null)).revision,hash('old text API'));
});
test('HTTP upload authority requires current grants, plugin permissions, pins, scope and non-revoked store',async t=>{
  const denied=await fixture(t,{grants:['workspace.read']});await assert.rejects(denied.client.beginUpload(spec(Buffer.from('x'))),{code:'permission_denied'});
  const undeclared=await fixture(t,{permissions:['workspace.read']});await assert.rejects(undeclared.client.beginUpload(spec(Buffer.from('x'))),{code:'permission_denied'});
  const f=await fixture(t);await assert.rejects(f.client.beginUpload(spec(Buffer.from('x'),{artifactSha256:'c'.repeat(64)})),{code:'plugin_mismatch'});await assert.rejects(f.client.beginUpload(spec(Buffer.from('x'),{path:'outside.bin'})),{code:'permission_denied'});
  const s=await f.client.beginUpload(spec(Buffer.from('x')));f.server.revokeUploads();await assert.rejects(f.client.writeUploadChunk(s.reference,chunk(Buffer.from('x'))),{code:'permission_denied'});assert.deepEqual((await f.client.listFiles('input')).entries,[]);
  await assert.rejects(createWorkspaceServer({workspaceId:randomUUID(),token,uploads:{},workspace:{}}),{code:'invalid_request'});
});
test('HTTP reply correlation rejects forged store, spec, generation, offset and receipt identities',async t=>{
  const f=await fixture(t),s=spec(Buffer.from('x')),begun=await f.client.beginUpload(s),caps=await f.client.getUploadCapabilities();
  const cases=[['uploads.capabilities',{...caps,scope:{...caps.scope,sessionId:randomUUID()}}],['uploads.begin',{...begun,reference:{...begun.reference,spec:{...s,path:'input/other'}}}],['uploads.begin',{...begun,reference:{...begun.reference,scope:{...begun.reference.scope,sessionId:randomUUID()}}}],['uploads.write',begun],['uploads.commit',begun]];
  for(const [method,result]of cases){const client=createWorkspaceClient({url:f.server.url,token,fetch:async(_url,options)=>{const request=JSON.parse(options.body);return Response.json({version:1,requestId:request.requestId,ok:true,result:request.method==='hello'?f.server.hello():request.method==='uploads.capabilities'&&method!=='uploads.capabilities'?caps:result});}});t.after(()=>client.dispose());await client.connect();await assert.rejects(method==='uploads.capabilities'?client.getUploadCapabilities():method==='uploads.begin'?client.beginUpload(s):method==='uploads.write'?client.writeUploadChunk(begun.reference,chunk(Buffer.from('x'))):client.commitUpload(begun.reference),{code:'invalid_request'});}
  assert.throws(()=>parseWorkspaceRequest({version:1,requestId:'test',workspaceId:f.server.workspaceId,generation:f.server.generation,method:'uploads.begin',params:{spec:{...s,extra:true}}}),{code:'invalid_request'});
  assert.throws(()=>parseWorkspaceMethodResult('uploads.commit',{...begun,state:'committed',offset:1,prefixSha256:s.sha256,commitReceipt:null}),{code:'invalid_request'});
});
test('selected source changes, wrong recovered content, invalid ranges and cancelled browser reads are rejected',async t=>{
  const f=await fixture(t),filePath=path.join(f.directory,'source');await fs.writeFile(filePath,'before');const source=await createNodeUploadSource({path:filePath});await fs.writeFile(filePath,'after');await assert.rejects(uploadFile(f.client,source,selected()),{code:'conflict'});
  let reads=0;await assert.rejects(uploadFile(f.client,{byteLength:1,read:async()=>{reads++;return new Uint8Array(1);}},selected({path:'../invalid'})),{code:'unsafe_path'});assert.equal(reads,0);
  assert.throws(()=>createBrowserUploadSource(new Blob(['x'])),{code:'invalid_request'});const browser=createBrowserUploadSource(new File(['abc'],'chosen.txt'));await assert.rejects(browser.read(2,2),{code:'invalid_request'});const controller=new AbortController();controller.abort();await assert.rejects(browser.read(0,3,{signal:controller.signal}),{code:'cancelled'});
  const target=selected(),saved=await f.client.beginUpload({...target,byteLength:3,sha256:hash('xyz')});await f.client.writeUploadChunk(saved.reference,chunk(Buffer.from('x')));await assert.rejects(uploadFile(f.client,browser,{...target,recover:true}),{code:'conflict'});
  const empty=await uploadFile(f.client,createBrowserUploadSource(new File([],'empty')),selected({path:'input/empty'}));assert.equal(empty.commitReceipt.revision,EMPTY_UPLOAD_SHA256);
});
