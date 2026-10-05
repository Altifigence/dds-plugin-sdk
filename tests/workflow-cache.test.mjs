import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath,utimes,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fingerprintWorkflowInputs,createWorkflowCache,createMemoryWorkflowCacheStore} from '../src/workflow-cache.mjs';
import {createNodeWorkflowCacheStore} from '../src/workflow-cache-node.mjs';
const binding={workspaceId:'workspace',securityScope:'operator'};
const input=()=>({scope:binding,commandId:'build',pluginSha256:'a'.repeat(64),toolSha256:'b'.repeat(64),schema:{v:1},settings:{strict:true},environment:{declared:['MODE'],values:{MODE:'test'}},input:{value:1},files:[{path:'src/main.ts',bytes:new TextEncoder().encode('hello')}],grants:['workspace.read'],policy:{optIn:true,deterministic:true,declaredInputsComplete:true,secretDependent:false}});
const delay=ms=>new Promise(r=>setTimeout(r,ms));

test('cache keys include file content, tool/plugin/schema, settings, environment, input and scope, while unknown and secret dependencies bypass',async()=>{
  const base=fingerprintWorkflowInputs(input());
  for(const change of [i=>i.files[0].bytes[0]++,i=>i.toolSha256='c'.repeat(64),i=>i.pluginSha256='d'.repeat(64),i=>i.schema.v=2,i=>i.settings.strict=false,i=>i.environment.values.MODE='other',i=>i.input.value=2,i=>i.scope={...binding,workspaceId:'other'},i=>i.grants=[]]){const i=input();change(i);assert.notEqual(fingerprintWorkflowInputs(i).key,base.key);}
  for(const change of [i=>i.policy.optIn=false,i=>i.policy.deterministic=false,i=>i.policy.declaredInputsComplete=false,i=>i.policy.secretDependent=true,i=>i.environment.values.EXTRA='x',i=>delete i.environment.values.MODE,i=>i.input={kind:'dds-secret-reference',id:'ref'}]){const i=input();change(i);const fp=fingerprintWorkflowInputs(i);assert.equal(fp.eligible,false);const c=createWorkflowCache({authorize:()=>true});assert.equal((await c.run(fp,{compute:async()=>1})).state,'bypass');await c.close();}
});

test('concurrent cache misses share one fill, hits recheck authorization, and revoked results are withheld',async()=>{
  let count=0,allowed=true;const cache=createWorkflowCache({authorize:()=>allowed});const fp=fingerprintWorkflowInputs(input());
  const results=await Promise.all(Array.from({length:6},()=>cache.run(fp,{compute:async()=>{count++;await delay(10);return {value:2};}})));
  assert.equal(count,1);assert.equal(results.filter(r=>r.state==='miss').length,1);assert.equal(results.filter(r=>r.state==='shared').length,5);
  assert.equal((await cache.run(fp,{compute:async()=>{throw Error('must not run');}})).state,'hit');allowed=false;await assert.rejects(cache.run(fp,{compute:async()=>0}),e=>e.code==='DENIED');await cache.close();
  let grants=true;const revoked=createWorkflowCache({authorize:()=>grants});await assert.rejects(revoked.run(fp,{compute:async()=>{grants=false;return 2;}}),e=>e.code==='DENIED');await revoked.close();
});

test('cache expiry, LRU/byte quota, cancelled follower, damaged entries and secret results do not expose stale output',async()=>{
  let now=1;const store=createMemoryWorkflowCacheStore(),cache=createWorkflowCache({store,authorize:()=>true,now:()=>now,ttlMs:10,maxEntries:2,maxBytes:20});
  const a=fingerprintWorkflowInputs(input()),b=fingerprintWorkflowInputs({...input(),input:{value:2}}),c=fingerprintWorkflowInputs({...input(),input:{value:3}});
  await cache.run(a,{compute:async()=>1});now++;await cache.run(b,{compute:async()=>2});now++;await cache.run(a,{compute:async()=>0});now++;await cache.run(c,{compute:async()=>3});assert.equal(await store.get(b.key),null);
  now=20;const clean=await cache.cleanup();assert.equal(clean.removed.length,2);assert.equal((await cache.run(a,{compute:async()=>4})).state,'miss');
  const ref=await cache.run(b,{compute:async()=>({kind:'dds-secret-reference',id:'r'})});assert.equal(ref.reason,'secret-result');assert.equal(await store.get(b.key),null);await cache.close();
  const shared=createWorkflowCache({authorize:()=>true}),abort=new AbortController();let resolve;const gate=new Promise(r=>{resolve=r;});
  const leader=shared.run(a,{compute:async()=>gate});await delay(1);const follower=shared.run(a,{compute:async()=>99,signal:abort.signal});const rejected=assert.rejects(follower,e=>e.code==='CANCELLED');await delay(1);abort.abort();await rejected;resolve(7);assert.equal((await leader).value,7);await shared.close();
});

test('node cache restarts, detects changed content with identical mtime and corrupted records, and preserves non-cache files',async()=>{
  const parent=await realpath(await mkdtemp(path.join(tmpdir(),'dds-cache-test-')));let store,cache;
  try{
    await mkdir(path.join(parent,'workspace'));await mkdir(path.join(parent,'store'));const source=path.join(parent,'workspace','file.txt');await writeFile(source,'first');const times=await stat(source);
    const opts={directory:path.join(parent,'store'),workspaceRoot:path.join(parent,'workspace'),scope:binding};store=await createNodeWorkflowCacheStore(opts);cache=createWorkflowCache({store,authorize:()=>true});
    const i=input();i.files[0].bytes=await readFile(source);const old=fingerprintWorkflowInputs(i);await cache.run(old,{compute:async()=>({result:1})});await cache.close();await store.close();
    store=await createNodeWorkflowCacheStore(opts);cache=createWorkflowCache({store,authorize:()=>true});assert.equal((await cache.run(old,{compute:async()=>0})).state,'hit');
    await writeFile(source,'other');await utimes(source,times.atime,times.mtime);i.files[0].bytes=await readFile(source);const fresh=fingerprintWorkflowInputs(i);assert.notEqual(old.key,fresh.key);assert.equal((await cache.run(fresh,{compute:async()=>({result:2})})).state,'miss');
    await cache.close();await store.close();await writeFile(path.join(parent,'store',old.key+'.json'),'invalid');await writeFile(path.join(parent,'store','do-not-remove.txt'),'keep');
    const orphan='.pending-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002';await writeFile(path.join(parent,'store',orphan),'{"incomplete":');
    store=await createNodeWorkflowCacheStore(opts);cache=createWorkflowCache({store,authorize:()=>true});const receipt=await cache.cleanup();assert.ok(receipt.recovery.removed.includes(old.key+'.json'));assert.ok(receipt.recovery.removed.includes(orphan));assert.ok(receipt.recovery.preserved.includes('do-not-remove.txt'));assert.equal(await readFile(source,'utf8'),'other');
  }finally{await cache?.close();await store?.close();assert.equal(path.dirname(parent),await realpath(tmpdir()));assert.ok(path.basename(parent).startsWith('dds-cache-test-'));await rm(parent,{recursive:true});}
});
