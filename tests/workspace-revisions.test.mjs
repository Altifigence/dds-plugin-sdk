import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient, createWorkspaceProject} from '../src/workspace-client.mjs';
import {parseWorkspaceRequest, parseWorkspaceMethodResult} from '../src/workspace-protocol.mjs';
import {deferred} from './fixtures.mjs';

const token = 'file-revisions-fixture-01234567890123456789';
const digest = text => createHash('sha256').update(text).digest('hex');
const disabled = {protocolVersion:1, revision:false, conditionalRead:false};
async function fixture(t, hook, serverOptions = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dds-revisions-')));
  await fs.writeFile(path.join(root, 'file.txt'), 'original 한글');
  const server = await createWorkspaceServer({root, token, workspaceId:randomUUID(), notice:{id:'test', version:'1', text:'Revision test'}, ...serverOptions});
  const requests = [], replies = [];
  const client = createWorkspaceClient({url:server.url, token, fetch:async (url, init) => {
    const request = JSON.parse(init.body); requests.push(request);
    const response = await (hook ? hook({request, init, server, send:()=>fetch(url,init)}) : fetch(url,init));
    replies.push({method:request.method, bytes:Buffer.byteLength(await response.clone().text())});
    return response;
  }});
  t.after(async()=>{client.dispose();await server.close();assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true});});
  await client.connect();
  return {root, server, client, requests, replies};
}
const success = (request, result) => Response.json({version:1, requestId:request.requestId, ok:true, result});
const failure = (request, code) => Response.json({version:1, requestId:request.requestId, ok:false, error:{code, message:'Fixture rejection'}});

test('revision and conditional reads keep content out of unchanged replies and preserve ordinary reads', async t => {
  const {root, client, requests} = await fixture(t, undefined, {writable:false});
  assert.deepEqual(await client.getFileCapabilities(), {protocolVersion:1, revision:true, conditionalRead:true});
  const first = await client.readFileIfChanged('file.txt', null);
  assert.deepEqual(first, {path:'file.txt', content:'original 한글', revision:digest('original 한글'), notModified:false});
  assert.deepEqual(await client.getFileRevision('file.txt'), {path:'file.txt', revision:first.revision});
  const unchanged = await client.readFileIfChanged('file.txt', first.revision);
  assert.deepEqual(unchanged, {path:'file.txt', revision:first.revision, notModified:true});
  assert.ok(Object.isFrozen(unchanged));
  await fs.writeFile(path.join(root,'file.txt'), 'new content');
  assert.deepEqual(await client.readFileIfChanged('file.txt',first.revision), {path:'file.txt', revision:digest('new content'), content:'new content', notModified:false});
  assert.equal((await client.readFile('file.txt')).content,'new content');
  assert.equal(requests.filter(r=>r.method==='fs.capabilities').length,1);
  await fs.unlink(path.join(root,'file.txt'));
  await assert.rejects(client.getFileRevision('file.txt'), {code:'not_found'});
  await assert.rejects(client.readFileIfChanged('file.txt',first.revision), {code:'not_found'});
});

for (const mode of ['legacy', 'unsupported', 'disabled']) test(`${mode} servers fall back to bounded reads and reset capabilities on reconnect`, async t => {
  let older = true;
  const {client, requests} = await fixture(t, ({request, server, send}) => {
    if (older && mode==='legacy' && request.method==='hello') return success(request,{...server.hello(),hostVersion:'0.5.0'});
    if (older && request.method==='fs.capabilities') return mode==='unsupported' ? failure(request,'unsupported') : success(request,disabled);
    return send();
  });
  assert.deepEqual(await client.getFileCapabilities(),disabled);
  const revision = (await client.getFileRevision('file.txt')).revision;
  assert.deepEqual(await client.readFileIfChanged('file.txt',revision),{path:'file.txt',revision,notModified:true});
  assert.equal((await client.readFileIfChanged('file.txt',null)).notModified,false);
  assert.equal(requests.filter(r=>r.method==='fs.read').length,3);
  assert.equal(requests.filter(r=>r.method==='fs.capabilities').length,mode==='legacy'?0:1);
  assert.ok(!requests.some(r=>['fs.revision','fs.readIfChanged'].includes(r.method)));
  older=false;await client.connect();
  assert.equal((await client.getFileCapabilities()).revision,true);
  await client.getFileRevision('file.txt');assert.equal(requests.at(-1).method,'fs.revision');
});

test('unknown methods are never silently inferred from invalid replies, permissions or transport failures', async t => {
  for (const code of ['invalid_request','permission_denied','authentication_required','generation_mismatch','unavailable','transport_failed']) {
    const {client,requests}=await fixture(t,({request,send})=>request.method==='fs.capabilities'?failure(request,code):send());
    await assert.rejects(client.getFileRevision('file.txt'),{code});
    assert.ok(!requests.some(r=>r.method==='fs.read'));
    if (['authentication_required','generation_mismatch'].includes(code)) assert.equal(client.binding,undefined);
  }
  for (const result of [{...disabled,revision:'yes'}, {...disabled,unknown:true}, {protocolVersion:2,revision:true,conditionalRead:true}]) {
    const {client,requests}=await fixture(t,({request,send})=>request.method==='fs.capabilities'?success(request,result):send());
    await assert.rejects(client.getFileRevision('file.txt'),{code:'invalid_request'});
    assert.ok(!requests.some(r=>r.method==='fs.read'));
  }
  const {client,requests}=await fixture(t,({request,send})=>request.method==='fs.capabilities'?failure({...request,requestId:'invalid-request'},'invalid_request'):send());
  await assert.rejects(client.getFileRevision('file.txt'),{code:'invalid_request'});
  assert.ok(!requests.some(r=>r.method==='fs.read'));
});

test('revision and conditional capabilities select their fallbacks independently', async t => {
  for(const revisionEnabled of [false,true]) {
    const {client,requests}=await fixture(t,({request,send})=>request.method==='fs.capabilities'?success(request,{protocolVersion:1,revision:revisionEnabled,conditionalRead:!revisionEnabled}):send());
    const file=await client.getFileRevision('file.txt');
    assert.equal((await client.readFileIfChanged(file.path,file.revision)).notModified,true);
    assert.deepEqual(requests.map(r=>r.method),['hello','fs.capabilities',revisionEnabled?'fs.revision':'fs.read',revisionEnabled?'fs.read':'fs.readIfChanged']);
  }
});

test('advertised operations fail directly if withdrawn rather than retrying full reads', async t => {
  const {client,requests}=await fixture(t,({request,send})=>['fs.revision','fs.readIfChanged'].includes(request.method)?failure(request,'unsupported'):send());
  await assert.rejects(client.getFileRevision('file.txt'),{code:'unsupported'});
  await assert.rejects(client.readFileIfChanged('file.txt',null),{code:'unsupported'});
  assert.ok(!requests.some(r=>r.method==='fs.read'));
});

test('file methods reject unsafe input before discovery and validate cached request options', async t => {
  const {client,requests}=await fixture(t);
  for (const value of ['../escape','.env','.git/config','C:/file.txt','folder\\file.txt']) {
    await assert.rejects(client.getFileRevision(value),{code:'unsafe_path'});
    await assert.rejects(client.readFileIfChanged(value,null),{code:'unsafe_path'});
  }
  for (const revision of [undefined,'bad',1,'A'.repeat(64)]) await assert.rejects(client.readFileIfChanged('file.txt',revision),{code:'invalid_request'});
  assert.equal(requests.length,1);
  await client.getFileCapabilities();const before=requests.length;
  for(const options of [{signal:{}},{timeoutMs:0},{timeoutMs:30001}]) await assert.rejects(client.getFileRevision('file.txt',options),{code:'invalid_request'});
  const abort=new AbortController();abort.abort();
  await assert.rejects(client.getFileCapabilities({signal:abort.signal}),{code:'cancelled'});
  assert.equal(requests.length,before);
  client.disconnect();await assert.rejects(client.getFileRevision('file.txt'),{code:'unavailable'});
  client.dispose();await assert.rejects(client.getFileCapabilities(),{code:'disposed'});
});

test('both new wire methods retain protected alias, byte limit and UTF-8 validation', async t => {
  const {root,client}=await fixture(t);
  await fs.writeFile(path.join(root,'.git-credentials'),'private fixture');
  await fs.link(path.join(root,'.git-credentials'),path.join(root,'alias.txt'));
  await fs.writeFile(path.join(root,'oversize.txt'),'a'.repeat(262145));
  await fs.writeFile(path.join(root,'binary.txt'),Buffer.from([0xff]));
  for (const [file,code] of [['alias.txt','unsafe_path'],['oversize.txt','budget_exceeded'],['binary.txt','invalid_request']]) {
    await assert.rejects(client.getFileRevision(file),{code});
    await assert.rejects(client.readFileIfChanged(file,null),{code});
  }
});

test('conditional replies are correlated with path and the exact requested revision', async t => {
  const revision=digest('original 한글');
  for(const [known,result] of [
    [null,null], [null,[]], [null,'unexpected'],
    [null,{path:'file.txt',revision,notModified:true}],
    [revision,{path:'file.txt',revision:digest('different'),notModified:true}],
    [revision,{path:'file.txt',revision,notModified:false,content:'original 한글'}],
    [revision,{path:'other.txt',revision,notModified:true}],
    [revision,{path:'file.txt',revision,notModified:true,content:'must be absent'}],
    [null,{path:'file.txt',revision,notModified:false}],
  ]) {
    const {client}=await fixture(t,({request,send})=>request.method==='fs.readIfChanged'?success(request,result):send());
    await assert.rejects(client.readFileIfChanged('file.txt',known),{code:'invalid_request'});
  }
  const {client}=await fixture(t,({request,send})=>request.method==='fs.revision'?success(request,{path:'other.txt',revision}):send());
  await assert.rejects(client.getFileRevision('file.txt'),{code:'invalid_request'});
});

test('cancellation and reconnection during discovery never issue a read on a replacement connection', {timeout:5000}, async t => {
  for(const action of ['abort','reconnect','timeout']) {
    const entered=deferred(),gate=deferred();let captured;
    const {client,requests}=await fixture(t,async({request,init,send})=>{
      const response=await send();if(request.method==='fs.capabilities'){captured=init.signal;entered.resolve();await gate.promise;}return response;
    });
    const abort=new AbortController();
    const pending=client.getFileRevision('file.txt',{signal:abort.signal,timeoutMs:action==='timeout'?100:3000});pending.catch(()=>{});
    await entered.promise;
    if(action==='abort')abort.abort();else if(action==='reconnect')await client.connect();
    await assert.rejects(pending,{code:action==='abort'?'cancelled':action==='timeout'?'budget_exceeded':'disposed'});
    assert.equal(captured.aborted,true);gate.resolve();await delay(20);
    assert.ok(!requests.some(r=>['fs.read','fs.revision'].includes(r.method)));
  }
});

test('unchanged file observation transfers only revisions and reports later changes', {timeout:5000}, async t => {
  const {root,client,requests,replies}=await fixture(t);
  await fs.writeFile(path.join(root,'file.txt'),'x'.repeat(200000));
  const project=createWorkspaceProject(client);t.after(()=>project.dispose());
  const files=project.watchFiles(['file.txt'],{intervalMs:250});await files.next();
  const pending=files.next();pending.catch(()=>{});
  for(let i=0;i<100&&replies.filter(r=>r.method==='fs.revision').length<3;i++)await delay(10);
  assert.ok(replies.filter(r=>r.method==='fs.revision').length>=3);
  assert.ok(replies.filter(r=>r.method==='fs.revision').every(r=>r.bytes<512));
  assert.ok(!requests.some(r=>r.method==='fs.read'));
  await fs.writeFile(path.join(root,'file.txt'),'changed');
  assert.equal((await pending).value.kind,'changed');await files.return();
});

test('new request and result contracts reject surplus content and ambiguous revisions', () => {
  const request={version:1,requestId:'test',workspaceId:randomUUID(),generation:randomUUID(),method:'fs.readIfChanged',params:{path:'file.txt',knownRevision:null}};
  assert.equal(parseWorkspaceRequest(request).params.knownRevision,null);
  assert.throws(()=>parseWorkspaceRequest({...request,params:{path:'file.txt'}}),{code:'invalid_request'});
  assert.throws(()=>parseWorkspaceRequest({...request,params:{...request.params,content:'extra'}}),{code:'invalid_request'});
  assert.throws(()=>parseWorkspaceMethodResult('fs.revision',{path:'file.txt',revision:digest('a'),content:'extra'}),{code:'invalid_request'});
});
