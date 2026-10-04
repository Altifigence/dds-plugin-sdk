import test from 'node:test';
import assert from 'node:assert/strict';
import {runConformance,parseConformanceReport,formatConformanceReport,CONFORMANCE_CASES} from '../src/conformance.mjs';
import {createSdkConformanceOptions} from '../src/conformance-node.mjs';
import {createPluginHost} from '../src/index.mjs';
const identity={host:'Custom test host',version:'1.0.0',runtime:'Node test',platform:'fixture'};
const core={identity,features:['commands','permissions','cancellation'],adapters:{host:createPluginHost}};

test('reference adapters exercise real HTTP storage, grants, generations, queries and generated contracts',async()=>{
  const r=await runConformance(createSdkConformanceOptions());
  assert.equal(r.ok,true,formatConformanceReport(r));assert.equal(r.summary.supported,CONFORMANCE_CASES.length);
  assert.deepEqual(parseConformanceReport(JSON.parse(JSON.stringify(r))),r);
});
test('independent core host reports optional and unknown capabilities without probing them',async()=>{
  let unknownCalls=0;const options={...core,features:[...core.features,'future-feature'],adapters:{...core.adapters,unknown(){unknownCalls++;}}};
  const r=await runConformance(options);assert.equal(r.ok,true);assert.equal(r.summary.supported,3);
  assert.equal(r.summary.unsupported,CONFORMANCE_CASES.length-3);assert.deepEqual(r.unknownFeatures,['future-feature']);assert.equal(unknownCalls,0);
  assert.ok(r.results.filter(v=>v.status==='unsupported').every(v=>v.cleanup==='not-run'));
});
test('missing or malformed custom adapters fail instead of claiming support',async()=>{
  const missing=await runConformance({...core,adapters:{}});assert.equal(missing.ok,false);assert.equal(missing.summary.failed,3);
  const r=await runConformance({...core,features:['commands'],requiredFeatures:['commands'],adapters:{host:()=>({activate(){},executeCommand:()=>({total:2}),deactivate(){},dispose(){}})}});
  assert.equal(r.ok,false);assert.equal(r.results[0].reason,'assertion');assert.equal(r.results[0].check,'valid_command');
});
test('a host that bypasses permission checks is detected even when it forwards successful commands',async()=>{
  const r=await runConformance({...core,features:['permissions'],requiredFeatures:['permissions'],adapters:{host:options=>createPluginHost({...options,grants:['workspace.read','backend.invoke']})}});
  assert.equal(r.ok,false);assert.equal(r.results.find(r=>r.id==='permissions').check,'missing_grant');
});
test('timeouts remain bounded, stop later fixtures and dispose a late-created host',async()=>{
  let release,disposed=0;const pending=new Promise(resolve=>{release=resolve;});
  const r=await runConformance({...core,timeoutMs:10,adapters:{host:()=>pending}});
  assert.equal(r.results[0].reason,'timed_out');assert.equal(r.results[0].cleanup,'pending');
  assert.equal(r.results[1].reason,'aborted_after_timeout');
  release({dispose(){disposed++;},activate(){throw Error('late fixture');}});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(disposed,1);
});
test('cleanup errors fail a passed case and provider secrets never appear in a report',async()=>{
  const r=await runConformance({...core,features:['commands'],requiredFeatures:['commands'],adapters:{host:()=>{const h=createPluginHost();return {...h,dispose(){h.dispose();throw Error('private-path-and-secret');}};}}});
  assert.equal(r.results[0].reason,'cleanup_failed');assert.equal(r.results[0].cleanup,'failed');assert.ok(!JSON.stringify(r).includes('private-path'));
  const failure=await runConformance({...core,adapters:{host(){throw Error('sensitive-provider-body');}}});assert.ok(!JSON.stringify(failure).includes('sensitive'));
});
test('report readback rejects forged summary, missing cases, extras and getters',async()=>{
  const r=await runConformance(core);assert.equal(r.ok,true);
  for(const changed of [{...r,ok:false},{...r,summary:{...r.summary,supported:99}},{...r,results:r.results.slice(1)},{...r,rawError:'sensitive'}])assert.throws(()=>parseConformanceReport(changed));
  let called=0;assert.throws(()=>parseConformanceReport({...r,get secret(){called++;}}));assert.equal(called,0);
  assert.throws(()=>parseConformanceReport({...r,results:r.results.map((v,i)=>i?{...v,id:r.results[0].id}:v)}));
});
test('pre-aborted runs create no fixtures and unrecognized required features are rejected',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const r=await runConformance({...core,signal:controller.signal,adapters:{host(){calls++;}}});assert.equal(calls,0);assert.equal(r.ok,false);
  await assert.rejects(runConformance({...core,requiredFeatures:['future-feature']}));
});
