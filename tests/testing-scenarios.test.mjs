import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPluginHost,definePlugin,createDiagnosticsResult,createLanguageResult} from '../src/index.mjs';
import {createTestClock,flushTestMicrotasks,createScenarioHost,createFaultController,createMemoryWorkspace,createTestRecorder,createTestReplay,parseTestTrace,createTestResources,createMemoryJobStore,TEST_LIMITS} from '../src/testing.mjs';
import {createConfigurationPlugin,settingsDefinition} from '../examples/configuration/plugin.mjs';
import {document,makePlugin,deferred} from './fixtures.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const manifest={manifestVersion:2,id:'synthetic-plugin',name:'Synthetic',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','workspace.write','backend.invoke'],supportedHosts:['test-host','workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const commandPlugin=handler=>definePlugin(manifest,context=>context.registerCommand({id:'example',title:'Example'},(input,options)=>handler(context,input,options)));
const scenario=async(t,options={})=>{const s=createScenarioHost(options);t.after(async()=>{await s.dispose();s.assertClean();});return s;};

test('virtual clocks preserve globals, reproduce IDs/order and reject timer storms and concurrent advancement',async()=>{
  const before=Date.now,timeout=setTimeout,a=createTestClock({seed:42,start:1000}),b=createTestClock({seed:42,start:1000});
  assert.deepEqual(Array.from({length:10},()=>a.runtime.randomUUID()),Array.from({length:10},()=>b.runtime.randomUUID()));
  const order=[];a.runtime.setTimeout(()=>order.push('late'),20);a.runtime.setTimeout(()=>{order.push('first');a.runtime.setTimeout(()=>order.push('nested'),0);},10);a.runtime.setTimeout(()=>order.push('second'),10);
  await a.advance(10);assert.deepEqual(order,['first','second','nested']);assert.equal(a.now(),1010);assert.equal(a.inspect().timers,1);await a.advance(10);assert.deepEqual(order,['first','second','nested','late']);assert.equal(Date.now,before);assert.equal(setTimeout,timeout);
  const running=a.advance(1);await assert.rejects(a.advance(1),{code:'conflict'});await running;
  const storm=()=>a.runtime.setTimeout(storm,0);storm();await assert.rejects(a.advance(0,{maxSteps:10}),{code:'budget_exceeded'});a.dispose();b.dispose();assert.equal(a.inspect().timers,0);
});

test('clock drives actual host timeout and retains ignored operations through disposal',async()=>{
  const s=createScenarioHost(),gate=deferred();await s.host.activate(commandPlugin(()=>gate.promise));
  const work=s.host.executeCommand(manifest.id,'example',{}, {timeoutMs:20});const rejection=assert.rejects(work,{code:'budget_exceeded'});await s.clock.advance(20);await rejection;
  assert.equal(s.host.inspect().pendingOperations,1);assert.equal(s.clock.inspect().timers,0);await s.dispose();assert.throws(()=>s.assertClean(),{code:'conflict'});
  gate.resolve(null);await flushTestMicrotasks();s.assertClean();
});

test('pending activation stays visible after timeout and is released only on actual settlement',async()=>{
  const s=createScenarioHost(),gate=deferred(),work=s.host.activate(definePlugin(manifest,()=>gate.promise));const rejection=assert.rejects(work,{code:'budget_exceeded'});await s.clock.advance(5000);await rejection;
  assert.equal(s.host.inspect().pendingActivations,1);await s.dispose();assert.throws(()=>s.assertClean(),{code:'conflict'});gate.resolve();await flushTestMicrotasks();s.assertClean();
});

test('diagnostics and language operations use virtual time and retain ignored cancellation',async()=>{
  const s=createScenarioHost({hostId:'test-host',grants:['document.read','diagnostics.publish','language.provide']}),gate=deferred();
  await s.host.activate(makePlugin(async request=>{await gate.promise;return createDiagnosticsResult(request,[]);}));s.host.setDocument(document);
  const requested=s.host.requestDiagnostics({timeoutMs:10}),rejected=assert.rejects(requested,{code:'budget_exceeded'});await s.clock.advance(10);await rejected;assert.equal(s.host.inspect().providerOperations,1);
  await s.dispose();assert.throws(()=>s.assertClean(),{code:'conflict'});gate.resolve();await flushTestMicrotasks();s.assertClean();
  const language=createScenarioHost({hostId:'test-host',grants:['document.read','language.provide']});
  await language.host.activate(definePlugin({...manifest,runtime:'ui',capabilities:['completion','completion-resolve'],permissions:['document.read','language.provide']},ctx=>ctx.registerLanguageProvider('completion',{languages:['plaintext']},{provide:r=>createLanguageResult(r,[{label:'example',insertText:'example',resolveData:{index:1}}]),resolve:(_r,item)=>({...item,detail:'Resolved'})})));
  language.host.setDocument(document);const result=await language.host.requestLanguage('completion',{position:{line:0,character:0}});assert.equal(language.host.inspect().resolveTokens,1);assert.ok(result.data[0].resolveToken);await language.clock.advance(60001);assert.equal(language.host.inspect().resolveTokens,0);await language.dispose();language.assertClean();
});

test('explicit grants revoke pending backend work and remain revoked on reactivation',async t=>{
  const s=await scenario(t,{grants:['backend.invoke'],backends:{analyzer:{ok:true}}});const plugin=commandPlugin(ctx=>ctx.backends.invoke('analyzer',{}));await s.host.activate(plugin);
  s.faults.enqueue({operation:'backend.analyzer',kind:'delay',delayMs:100});const work=s.host.executeCommand(manifest.id,'example',{}),rejected=assert.rejects(work,{code:'disposed'});await flushTestMicrotasks();s.replaceGrants([]);await rejected;await flushTestMicrotasks();assert.equal(s.faults.inspect().pending,0);assert.equal(s.clock.inspect().timers,0);
  await s.host.activate(plugin);await assert.rejects(s.host.executeCommand(manifest.id,'example',{}),{code:'permission_denied'});
});

test('memory workspace enforces CAS, byte budgets, portable paths and emits bounded synthetic snapshots',async t=>{
  const s=await scenario(t,{files:{'src/example.txt':'old'},grants:['workspace.read','workspace.write']}),w=s.workspace;
  const before=await w.port.readFile('src/example.txt');assert.equal(before.revision,sha('old'));
  const observed=[],subscription=w.subscribe('src',snapshot=>observed.push(snapshot));
  await w.port.writeFile('src/example.txt','new',{expectedRevision:before.revision});assert.equal(observed.length,1);assert.equal(observed[0].entries[0].revision,sha('new'));
  await assert.rejects(w.port.writeFile('src/example.txt','stale',{expectedRevision:before.revision}),{code:'conflict'});assert.equal((await w.port.readFile('src/example.txt')).content,'new');
  assert.throws(()=>w.setFile('SRC/EXAMPLE.TXT','bad'),{code:'conflict'});assert.throws(()=>w.setFile('../escape','bad'));assert.throws(()=>w.setFile('large.bin',new Uint8Array(TEST_LIMITS.fileBytes+1)));subscription.dispose();assert.equal(w.inspect().subscriptions,0);
  s.replaceGrants([]);await assert.rejects(w.port.readFile('src/example.txt'),{code:'permission_denied'});
});

test('memory binary chunks and job events are deterministic and corruption is surfaced to callers',async t=>{
  const input=new Uint8Array([0,1,2,255]),s=await scenario(t,{seed:88,start:2000,files:{'result.bin':input},grants:['workspace.read'],jobs:true,binaryArtifacts:true});
  const source=await s.workspace.port.captureBinaryFile('result.bin'),chunk=await source.readChunk(0,4);assert.equal(chunk.sha256,sha(input));assert.equal(chunk.data,'AAEC/w==');
  await s.host.activate(commandPlugin(async(_ctx,_input,{job})=>{await job.addBinaryArtifact({id:'result',path:'result.bin'});return {ok:true};}));const id=s.clock.runtime.randomUUID();s.host.startCommandJob(manifest.id,'example',{}, {jobId:id});
  await flushTestMicrotasks(128);assert.equal(s.host.getJob(id).state,'succeeded');assert.ok(s.host.getJobEvents(id).events.every(event=>event.at===2000));
  s.faults.enqueue({operation:'file.chunk',kind:'corrupt',value:{offset:0,nextOffset:4,eof:true,data:'AAEC/w==',sha256:'0'.repeat(64)}});
  await assert.rejects(s.host.readJobBinaryArtifactChunk(id,'result',sha(input),0,4),{code:'conflict'});
});

test('faults delay, reject, disconnect, exhaust and drop cooperatively; event faults do not repeat effects',async()=>{
  const clock=createTestClock(),f=createFaultController(clock.runtime);let effects=0;
  for(const [kind,code]of [['deny','permission_denied'],['disconnect','capability_unavailable'],['exhaust','budget_exceeded']]){f.enqueue({operation:'example',kind});await assert.rejects(f.invoke('example',()=>effects++),{code});}
  f.enqueue({operation:'example',kind:'drop'});const controller=new AbortController(),dropped=f.invoke('example',()=>effects++,{signal:controller.signal}),rejected=assert.rejects(dropped,{code:'cancelled'});controller.abort();await rejected;
  f.enqueue({operation:'example',kind:'delay',delayMs:10});const delayed=f.invoke('example',()=>++effects);await clock.advance(9);assert.equal(effects,0);await clock.advance(1);assert.equal(await delayed,1);
  assert.deepEqual(f.events([{sequence:1},{sequence:2}],{duplicate:0,reverse:true}),[{sequence:2},{sequence:1},{sequence:1}]);assert.equal(effects,1);assert.deepEqual(f.inspect(),{queued:0,pending:0});f.dispose();clock.dispose();
});

test('settings, secrets and command jobs share the selected clock and clean subscriptions/leases',async t=>{
  const s=await scenario(t,{settings:[settingsDefinition],secrets:{token:new TextEncoder().encode('synthetic-token-only')},grants:['settings.read','secrets.resolve'],jobs:true}),store=s.settings['configuration-example'];
  const reference=s.secrets.issue({secretId:'token',pluginId:'configuration-example',workspaceId:'synthetic-project',commandIds:['summarize'],ttlMs:50});await s.host.activate(createConfigurationPlugin());
  const input={options:{names:['one','two']},token:reference};assert.deepEqual(await s.host.executeCommand('configuration-example','summarize',input),{count:2,total:4,mode:'short',authorized:true});
  store.update({workspaceId:'synthetic-project',scope:'workspace',expectedRevision:0,values:{multiplier:3}});assert.equal((await s.host.executeCommand('configuration-example','summarize',input)).total,6);
  await s.clock.advance(50);await assert.rejects(s.host.executeCommand('configuration-example','summarize',input),{code:'permission_denied'});assert.equal(s.secrets.inspect().references,0);
});

test('secret timeout erases SDK bytes even when a callback ignores virtual cancellation',async()=>{
  const s=createScenarioHost({secrets:{token:new Uint8Array([1,2,3])},grants:['secrets.resolve']}),gate=deferred();const reference=s.secrets.issue({secretId:'token',pluginId:'synthetic-plugin',workspaceId:'synthetic-project',commandIds:['example']});let borrowed;
  const p=s.secrets.withSecret(reference,{pluginId:'synthetic-plugin',workspaceId:'synthetic-project',commandId:'example',executionId:s.clock.runtime.randomUUID()},async bytes=>{borrowed=bytes;await gate.promise;},{timeoutMs:10}),rejected=assert.rejects(p,{code:'budget_exceeded'});
  await s.clock.advance(10);await rejected;assert.deepEqual([...borrowed],[0,0,0]);await s.dispose();assert.throws(()=>s.assertClean(),{code:'conflict'});gate.resolve();await flushTestMicrotasks();s.assertClean();
});

test('trace exports hashes only and replay rejects altered order, seed, fixture version and injected fields',()=>{
  const options={synthetic:true,seed:17,fixtureVersion:1,fixtures:[{id:'greeting',operation:'command',input:{value:'synthetic-input'},output:{value:'synthetic-output'}}]},recorder=createTestRecorder(options);
  recorder.record('greeting',{value:'synthetic-input'},{value:'synthetic-output'});recorder.record('greeting',{value:'synthetic-input'},{value:'synthetic-output'});const trace=recorder.snapshot(),json=JSON.stringify(trace);assert.ok(!json.includes('synthetic-input'));assert.ok(!json.includes('synthetic-output'));
  const replay=createTestReplay(trace,options);assert.deepEqual(replay.next('greeting',{value:'synthetic-input'}),{value:'synthetic-output'});assert.throws(()=>replay.assertComplete(),{code:'conflict'});replay.next('greeting',{value:'synthetic-input'});replay.assertComplete();assert.throws(()=>replay.next('greeting',{value:'synthetic-input'}),{code:'conflict'});
  for(const key of ['seed','fixtureVersion'])assert.throws(()=>createTestReplay(trace,{...options,[key]:2}),{code:'version_mismatch'});
  const reversed=structuredClone(trace);reversed.events.reverse();assert.throws(()=>parseTestTrace(reversed),{code:'conflict'});const corrupt=structuredClone(trace);corrupt.events[0].outputSha256='0'.repeat(64);assert.throws(()=>parseTestTrace(corrupt),{code:'conflict'});
  assert.throws(()=>parseTestTrace({...trace,rawInput:'private'}));assert.throws(()=>createTestRecorder({...options,synthetic:false}));assert.throws(()=>recorder.record('greeting',{value:'unselected'},{}),{code:'conflict'});
  const same=createTestRecorder(options);same.record('greeting',{value:'synthetic-input'},{value:'synthetic-output'});same.record('greeting',{value:'synthetic-input'},{value:'synthetic-output'});assert.deepEqual(same.snapshot(),trace);
});

test('trace event budget remains serializable and replayable at its advertised boundary',()=>{
  const options={synthetic:true,seed:1,fixtureVersion:1,fixtures:[{id:'boundary',operation:'command',input:{},output:{ok:true}}]},recorder=createTestRecorder(options);
  for(let i=0;i<1024;i++)recorder.record('boundary',{}, {ok:true});
  const trace=parseTestTrace(JSON.parse(JSON.stringify(recorder.snapshot())));assert.equal(trace.events.length,1024);
  assert.throws(()=>recorder.record('boundary',{}, {ok:true}),{code:'budget_exceeded'});
  const replay=createTestReplay(trace,options);for(let i=0;i<1024;i++)assert.deepEqual(replay.next('boundary',{}),{ok:true});replay.assertComplete();
});

test('owner resource ledger keeps failed cleanup visible and repeated host lifecycles leave no owned work',async()=>{
  const resources=createTestResources();let closed=0,fail=true;
  const handle=resources.track('file-handle',()=>{if(fail)throw new Error('synthetic failure');closed++;});assert.throws(()=>resources.assertEmpty(),{code:'conflict'});await assert.rejects(handle.release());assert.equal(resources.inspect()['file-handle'],1);fail=false;await handle.release();await handle.release();assert.equal(closed,1);resources.assertEmpty();
  for(let i=0;i<25;i++){const s=createScenarioHost();await s.host.activate(commandPlugin(()=>({ok:true})));await s.host.executeCommand(manifest.id,'example',{});await s.dispose();s.assertClean();}
});

test('trusted runtime ports and fixture metadata reject accessor hooks and unsupported inputs',()=>{
  let invoked=0;assert.throws(()=>createPluginHost({runtime:{get now(){invoked++;return()=>0;},setTimeout(){},clearTimeout(){},randomUUID(){}}}));assert.equal(invoked,0);
  assert.throws(()=>createTestClock({seed:-1}));assert.throws(()=>createMemoryWorkspace({files:{get example(){invoked++;return'bad';}}}));assert.equal(invoked,0);assert.throws(()=>createScenarioHost({grants:['unknown']}));
});

test('memory checkpoints simulate restart without re-execution and reject corrupted journals, origin changes and stale CAS',async()=>{
  const clock=createTestClock({seed:52,start:2000}),identity={schemaVersion:1,storeId:clock.runtime.randomUUID(),workspaceId:'synthetic-project',workspaceIdentity:sha('synthetic-workspace')},store=createMemoryJobStore({identity});
  const storage=store=>({store,workspaceIdentity:identity.workspaceIdentity,pluginArtifacts:{[manifest.id]:sha('synthetic-plugin-artifact')}});
  const first=createScenarioHost({seed:53,start:2000,grants:['workspace.read'],jobs:true,jobStorage:storage(store)}),gate=deferred();let executions=0;const plugin=commandPlugin(async()=>{executions++;await gate.promise;return {ok:true};});await first.host.activate(plugin);
  const jobId=first.clock.runtime.randomUUID();first.host.startCommandJob(manifest.id,'example',{}, {jobId});await first.host.flushJobStore();await flushTestMicrotasks();assert.equal(executions,1);
  const saved=store.snapshot();assert.equal(saved.records[0].savedAt,2000);const altered=structuredClone(saved);altered.records[0].requestSha256='0'.repeat(64);assert.throws(()=>createMemoryJobStore({identity,snapshot:altered}),{code:'conflict'});
  assert.throws(()=>createMemoryJobStore({identity:{...identity,workspaceIdentity:sha('different')},snapshot:saved}),{code:'conflict'});
  const recoveredStore=createMemoryJobStore({identity,snapshot:saved}),second=createScenarioHost({seed:54,start:2000,grants:['workspace.read'],jobs:true,jobStorage:storage(recoveredStore)});await second.host.activate(plugin);
  assert.equal(second.host.recoverJob(manifest.id,jobId).disposition,'interrupted');assert.equal(executions,1);assert.equal(second.host.listJobHistory(manifest.id).asOf,2000);
  const record=recoveredStore.get(jobId);await assert.rejects(recoveredStore.write(record,0),{code:'conflict'});
  recoveredStore.markUnavailable(jobId,'corrupt');assert.equal(second.host.recoverJob(manifest.id,jobId).disposition,'corrupt');recoveredStore.markUnavailable(jobId,'unsupported');assert.equal(second.host.recoverJob(manifest.id,jobId).disposition,'unsupported');
  gate.resolve();await flushTestMicrotasks(128);await first.host.flushJobStore();await first.dispose();await first.host.flushJobStore();first.assertClean();assert.equal(store.inspect().pins,0);await second.dispose();second.assertClean();store.dispose();recoveredStore.dispose();clock.dispose();
});

test('virtual settings migration timeout retains unfinished work and grants do not imply unmounted capabilities',async()=>{
  const s=createScenarioHost({settings:[settingsDefinition],grants:['workspace.read']}),store=s.settings['configuration-example'],gate=deferred();await s.host.activate(commandPlugin(ctx=>ctx.workspace.readFile('missing.txt')));
  await assert.rejects(s.host.executeCommand(manifest.id,'example',{}),{code:'capability_unavailable'});assert.equal(s.capabilities.workspace,false);
  const pending=store.migrate({...settingsDefinition,version:2},()=>gate.promise,{expectedRevision:0,timeoutMs:10}),rejected=assert.rejects(pending,{code:'budget_exceeded'});await s.clock.advance(10);await rejected;assert.equal(store.inspect().pendingMigrations,1);
  await s.dispose();assert.throws(()=>s.assertClean(),{code:'conflict'});gate.resolve({user:{},workspaces:{}});await flushTestMicrotasks();s.assertClean();
});
