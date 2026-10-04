import assert from 'node:assert/strict';
import {definePlugin,createLanguageResult} from '@altifigence/dds-plugin-sdk';
import {createScenarioHost,createTestRecorder,createTestReplay,flushTestMicrotasks} from '@altifigence/dds-plugin-sdk/testing';
import {createDiagnosticSession,profileHost} from '@altifigence/dds-plugin-sdk/diagnostics';

// Only these tiny invented fixtures are used. No workspace discovery or real credentials.
const manifest={manifestVersion:2,id:'development-example',name:'Development Example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./run.mjs',runtime:'workspace',capabilities:['commands','settings'],permissions:['workspace.read','backend.invoke','settings.read','secrets.resolve'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const definition={schemaVersion:1,pluginId:manifest.id,version:1,settings:{multiplier:{schema:{schemaVersion:1,schema:{type:'integer',default:2,minimum:1,maximum:10}},scopes:['user','workspace']}}};
const scenario=createScenarioHost({seed:7,start:1000,files:{'result.txt':'synthetic result'},backends:{analyzer:{value:3}},settings:[definition],secrets:{token:new Uint8Array([1,2,3])},grants:['workspace.read','backend.invoke','settings.read','secrets.resolve'],jobs:true,binaryArtifacts:true});
const diagnostics=createDiagnosticSession({enabled:true,now:scenario.clock.now}),host=profileHost(scenario.host,diagnostics);
try{
  await host.activate(definePlugin(manifest,ctx=>ctx.registerCommand({id:'analyze',title:'Analyze'},async(_input,{signal,job})=>{
    const file=await ctx.workspace.readFile('result.txt',{signal}),value=await ctx.backends.invoke('analyzer',{}, {signal}),settings=await ctx.settings.read({signal});
    if(job){job.log('info','Synthetic analysis');await job.addBinaryArtifact({id:'result',path:'result.txt'});job.reportProgress({completed:1,total:1});}
    return {total:value.value*settings.values.multiplier,bytes:new TextEncoder().encode(file.content).byteLength};
  })));
  const expected={total:6,bytes:16},options={synthetic:true,seed:7,fixtureVersion:1,fixtures:[{id:'analyze',operation:'command',input:{},output:expected}]};
  const recorder=createTestRecorder({...options,now:scenario.clock.now});scenario.faults.enqueue({operation:'backend.analyzer',kind:'delay',delayMs:25});
  const pending=host.executeCommand(manifest.id,'analyze',{});await scenario.clock.advance(25);const result=await pending;assert.deepEqual(result,expected);recorder.record('analyze',{},result);
  const replay=createTestReplay(recorder.snapshot(),options);assert.deepEqual(replay.next('analyze',{}),result);replay.assertComplete();
  const watched=[],subscription=scenario.workspace.subscribe('',snapshot=>watched.push(snapshot));scenario.workspace.setFile('second.txt','another fixture');assert.equal(watched.length,1);subscription.dispose();
  const jobId=scenario.clock.runtime.randomUUID();host.startCommandJob(manifest.id,'analyze',{}, {jobId});await flushTestMicrotasks(128);assert.equal(host.getJob(jobId).state,'succeeded');const artifact=host.listJobBinaryArtifacts(jobId).artifacts[0];assert.equal((await host.readJobBinaryArtifactChunk(jobId,'result',artifact.revision,0,16)).eof,true);
  const reference=scenario.secrets.issue({secretId:'token',pluginId:manifest.id,workspaceId:'synthetic-project',commandIds:['analyze'],ttlMs:10});let borrowed;
  await scenario.secrets.withSecret(reference,{pluginId:manifest.id,workspaceId:'synthetic-project',commandId:'analyze',executionId:scenario.clock.runtime.randomUUID()},bytes=>{borrowed=bytes;assert.equal(bytes.length,3);});assert.ok(borrowed.every(byte=>byte===0));
  await scenario.clock.advance(10);assert.equal(scenario.secrets.inspect().references,0);
  const language=definePlugin({...manifest,id:'synthetic-language',runtime:'ui',capabilities:['hover'],permissions:['document.read','language.provide']},ctx=>ctx.registerLanguageProvider('hover',{languages:['synthetic']},{provide:request=>createLanguageResult(request,{text:'Synthetic hover'})}));
  await host.activate(language).then(()=>assert.fail('Missing grants must reject'),error=>assert.equal(error.code,'permission_denied'));
  scenario.replaceGrants(['workspace.read','backend.invoke','settings.read','secrets.resolve','document.read','language.provide']);await host.activate(language);host.setDocument({uri:'memory:///synthetic.txt',languageId:'synthetic',modelVersion:1,workspaceRevision:'one',text:'example'});assert.equal((await host.requestLanguage('hover',{position:{line:0,character:0}})).data.text,'Synthetic hover');
  scenario.replaceGrants(['workspace.read']);await assert.rejects(host.executeCommand(manifest.id,'analyze',{}),{code:'disposed'});
  host.dispose();const report=diagnostics.snapshot();assert.ok(report.events.some(event=>event.operation==='command'&&event.durationMs===25));assert.equal(report.events.at(-1).resources.commands,0);assert.ok(!JSON.stringify(report).includes('result.txt'));
  console.log('Development tools: seeded clock, file CAS/snapshot, backend delay, settings, secret cleanup, job binary result, pure trace replay and bounded diagnostics verified');
}finally{host.dispose();await scenario.dispose();scenario.assertClean();diagnostics.dispose();}
