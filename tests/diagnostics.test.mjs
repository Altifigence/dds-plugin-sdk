import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiagnosticSession,parseDiagnosticReport,profileHost,profileTransport,DIAGNOSTIC_RESOURCES} from '../src/diagnostics.mjs';
import {createScenarioHost,flushTestMicrotasks} from '../src/testing.mjs';
import {definePlugin,PluginSdkError} from '../src/index.mjs';
import {deferred} from './fixtures.mjs';

const manifest={manifestVersion:2,id:'synthetic-profile',name:'Synthetic profile',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:[],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};

test('diagnostics are disabled by default and do not collect inputs, output or arbitrary errors',async()=>{
  let calls=0;const off=createDiagnosticSession({now:()=>{throw Error('Clock should not run');}});assert.equal(off.measure('command',()=>++calls),1);assert.equal(off.snapshot().enabled,false);assert.deepEqual(off.snapshot().events,[]);
  const local=createDiagnosticSession({enabled:true,now:()=>10});const error=new Error('synthetic secret /private/source customer body');await assert.rejects(local.measure('command',async()=>{throw error;}),e=>e===error);const report=local.snapshot();assert.equal(report.events[0].errorCode,'provider_failed');assert.ok(!JSON.stringify(report).includes('private'));assert.ok(!JSON.stringify(report).includes('secret'));assert.equal(calls,1);
  assert.throws(()=>local.begin('command',{input:'private'}));assert.throws(()=>parseDiagnosticReport({...report,secret:'private'}));
});

test('manual spans correlate fixed stages and accept bounded byte/resource estimates only',()=>{
  let now=100;const d=createDiagnosticSession({enabled:true,now:()=>now}),command=d.begin('command',{inputBytes:8,queueDepth:2});now=105;
  const transport=d.begin('transport',{parentId:command.id,inputBytes:64});now=115;transport.end({outputBytes:128,resources:{memoryBytes:1024}});now=120;command.end({outputBytes:12,resources:{pendingOperations:0}});
  const report=d.snapshot(),[child,parent]=report.events;assert.equal(child.parentId,parent.id);assert.equal(child.durationMs,10);assert.equal(parent.durationMs,20);assert.equal(child.outputBytes,128);assert.equal(parent.queueDepth,2);assert.equal(report.pending,0);
  assert.throws(()=>d.begin('arbitrary-path'));assert.throws(()=>d.begin('command',{parentId:'d999'}));assert.throws(()=>d.begin('command',{inputBytes:-1}));const live=d.begin('command');assert.throws(()=>live.end({errorCode:'private error'}));live.end({status:'cancelled',errorCode:'cancelled'});
});

test('ring capacity, sampling, passive TTL, inflight cap and export bounds stay finite',()=>{
  let now=0;const d=createDiagnosticSession({enabled:true,capacity:3,sampleEvery:2,retentionMs:50,now:()=>now});for(let i=0;i<20;i++)d.measure('command',()=>null);assert.equal(d.snapshot().attempted,20);assert.equal(d.snapshot().sampled,10);assert.equal(d.snapshot().events.length,3);now=50;assert.equal(d.snapshot().events.length,0);
  const bounded=createDiagnosticSession({enabled:true,now:()=>now});for(let i=0;i<100;i++)bounded.begin('command');assert.equal(bounded.snapshot().pending,64);assert.equal(bounded.snapshot().dropped,36);bounded.dispose();assert.equal(bounded.snapshot().pending,0);assert.equal(bounded.snapshot().dropped,100);
  const maximum=createDiagnosticSession({enabled:true,capacity:256,now:()=>now}),resources=Object.fromEntries(DIAGNOSTIC_RESOURCES.map(key=>[key,1_000_000_000_000]));for(let i=0;i<300;i++){const span=maximum.begin('transport',{inputBytes:1_000_000_000_000,queueDepth:1_000_000_000_000});span.end({outputBytes:1_000_000_000_000,resources});}const report=maximum.snapshot();assert.equal(report.events.length,256);assert.ok(Buffer.byteLength(JSON.stringify(report))<262144);
});

test('profiled host keeps actual pending resources visible after caller cancellation',async()=>{
  const s=createScenarioHost(),d=createDiagnosticSession({enabled:true,now:s.clock.now}),host=profileHost(s.host,d),gate=deferred();await host.activate(definePlugin(manifest,ctx=>ctx.registerCommand({id:'wait',title:'Wait'},()=>gate.promise)));
  const p=host.executeCommand(manifest.id,'wait',{}, {timeoutMs:10}),rejected=assert.rejects(p,{code:'budget_exceeded'});await s.clock.advance(10);await rejected;
  const event=d.snapshot().events.find(event=>event.operation==='command');assert.equal(event.durationMs,10);assert.equal(event.resources.pendingOperations,1);assert.equal(event.errorCode,'budget_exceeded');host.dispose();assert.equal(d.snapshot().events.at(-1).resources.commands,0);
  gate.resolve(null);await flushTestMicrotasks();await s.dispose();s.assertClean();d.dispose();
});

test('instrumented transport preserves receiver/results and reports safe failures without body reads',async()=>{
  const d=createDiagnosticSession({enabled:true}),response={get body(){throw Error('Must not collect payload');}},owner={response};owner.send=profileTransport(function(_input){return this.response;},d);assert.equal(owner.send({authorization:'synthetic-private'}),response);
  const error=new PluginSdkError('cancelled','private body');const rejecting=profileTransport(async()=>{throw error;},d);await assert.rejects(rejecting(),e=>e===error);const report=d.snapshot();assert.equal(report.events[0].operation,'transport');assert.equal(report.events[1].status,'cancelled');assert.ok(!JSON.stringify(report).includes('authorization'));
});

test('broken diagnostic clock cannot break a measured operation and hostile metadata hooks never run',()=>{
  const d=createDiagnosticSession({enabled:true,now:()=>{throw Error('Synthetic clock failure');}});assert.equal(d.measure('command',()=>42),42);
  let reads=0;const valid=createDiagnosticSession({enabled:true});assert.throws(()=>valid.begin('command',{get inputBytes(){reads++;return 1;}}));assert.equal(reads,0);
});
