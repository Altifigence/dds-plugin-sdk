import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPluginHost, definePlugin} from '../src/index.mjs';
import {JOB_LIMITS, parseJobOptions, parseJobSnapshot, parseJobEvents, parseJobProgress} from '../src/jobs.mjs';
import {deferred} from './fixtures.mjs';

const manifest = {manifestVersion:2,id:'job-example',name:'Job example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','workspace.write','backend.invoke'],supportedHosts:['test-host','workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, handler, options = {}) {
  const host = createPluginHost({jobs:true, ...options}); let context, registration;
  await host.activate(definePlugin(manifest, ctx => {context=ctx; registration=ctx.registerCommand({id:'analyze',title:'Analyze'},handler);}));
  t.after(() => host.dispose());
  return {host, context, registration, start: (input = {}, options = {}) => host.startCommandJob(manifest.id, 'analyze', input, {jobId:randomUUID(), ...options})};
}
async function finished(host, id) {
  const deadline = Date.now() + 5_000;
  for (;;) {const job=host.getJob(id);if(job.state!=='running')return job;if(Date.now()>deadline)throw Error('Job did not settle');await delay(5);}
}

test('jobs are opt-in; exact options and progress reject hooks, unknown keys and invalid budgets', async t => {
  const {host,start}=await fixture(t,()=>null,{jobs:false});
  assert.equal(host.jobCapabilities().enabled,false);assert.throws(()=>start(),{code:'capability_unavailable'});
  for(const options of [{jobId:'bad'},{jobId:randomUUID(),timeoutMs:0},{jobId:randomUUID(),timeoutMs:JOB_LIMITS.maxTimeoutMs+1},{jobId:randomUUID(),input:{}}])assert.throws(()=>parseJobOptions(options),{code:'invalid_contract'});
  let hooks=0;assert.throws(()=>parseJobOptions({get jobId(){hooks++;return randomUUID();}}));assert.equal(hooks,0);
  for(const value of [{completed:2,total:1},{completed:0,total:0},{completed:0,total:1,message:'secret\nline'},{completed:0,total:1,message:'한'.repeat(1_000)}])assert.throws(()=>parseJobProgress(value));
});
test('jobs report progress/logs, invoke an authorized backend and pin a workspace artifact', async t => {
  let reporter, backendOptions; const content='module top; endmodule\n';
  const {host,start}=await fixture(t,async(input,{signal,job})=>{reporter=job;assert.ok(signal instanceof AbortSignal);job.reportProgress({completed:1,total:2});job.log('info','Analyzing');const output=await job.invokeBackend('analyzer',input);await job.addArtifact({id:'report',path:'report.txt',label:'Report'});job.reportProgress({completed:2,total:2});return output;},{grants:['workspace.read','backend.invoke'],workspace:{readFile:async path=>({path,content,revision:sha(content)})},backends:{analyzer:async(input,options)=>{backendOptions=options;options.job.log('info','Backend progress');return{count:input.count};}}});
  const first=start({count:2});assert.equal(first.state,'running');assert.ok(Object.isFrozen(first));
  const result=await finished(host,first.jobId);assert.equal(result.state,'succeeded');assert.deepEqual(result.result,{count:2});assert.equal(result.progress.completed,2);
  assert.equal(backendOptions.scope.projectId,result.scope.projectId);assert.equal(backendOptions.pluginId,manifest.id);
  assert.equal((await host.readJobArtifact(first.jobId,'report')).content,content);assert.equal(result.artifacts[0].revision,sha(content));
  assert.throws(()=>reporter.log('info','late'),{code:'cancelled'});
  assert.equal(host.getJobEvents(first.jobId).events.filter(e=>e.kind==='log').length,2);
});
test('same retained job ID is idempotent with canonical JSON; different inputs never rerun it', async t => {
  const gate=deferred();let executions=0;
  const {host,start}=await fixture(t,async()=>{executions++;await gate.promise;return 1;});
  const jobId=randomUUID(),job=start({a:1,b:2},{jobId});
  assert.equal(start({b:2,a:1},{jobId}).jobId,job.jobId);assert.throws(()=>start({a:2,b:2},{jobId}),{code:'conflict'});
  await delay(0);assert.equal(executions,1);gate.resolve();await finished(host,jobId);
  assert.equal(start({b:2,a:1},{jobId}).state,'succeeded');assert.equal(executions,1);
});
test('cancelled uncooperative work keeps its concurrency slot and cannot publish late results', async t => {
  const gate=deferred(),signals=[];
  const {host,start}=await fixture(t,async(_,{signal,job})=>{signals.push(signal);await gate.promise;if(signal.aborted)assert.throws(()=>job.log('info','late'),{code:'cancelled'});return{late:true};});
  const jobs=Array.from({length:JOB_LIMITS.concurrent},()=>start());await delay(0);
  for(const job of jobs)assert.equal(host.cancelJob(job.jobId).state,'cancelled');assert.ok(signals.every(s=>s.aborted));
  assert.throws(()=>start(),{code:'budget_exceeded'});gate.resolve();await delay(10);
  for(const job of jobs)assert.equal(host.getJob(job.jobId).result,undefined);
  const next=start();assert.equal((await finished(host,next.jobId)).state,'succeeded');
});
test('timeout, registration disposal, plugin deactivation and host disposal abort jobs', async t => {
  for(const mode of ['timeout','registration','deactivate','dispose']) {
    const started=deferred(),gate=deferred();let signal;
    const {host,start,registration}=await fixture(t,async(_,{signal:s})=>{signal=s;started.resolve();await gate.promise;return 7;});
    const job=start({},mode==='timeout'?{timeoutMs:15}:{});await started.promise;
    if(mode==='registration')registration.dispose();else if(mode==='deactivate')host.deactivate(manifest.id);else if(mode==='dispose')host.dispose();
    if(mode==='timeout')assert.equal((await finished(host,job.jobId)).state,'timed_out');else assert.throws(()=>host.getJob(job.jobId),{code:'disposed'});
    assert.equal(signal.aborted,true);gate.resolve();
  }
});
test('bounded event ring reports dropped events and stable pagination cursors', async t => {
  const {host,start}=await fixture(t,(_,{job})=>{for(let i=0;i<400;i++)job.log('info',`event-${i}: ${'x'.repeat(300)}`);return null;});
  const result=await finished(host,start().jobId);let cursor=0,total=0,dropped=0;
  do {const page=host.getJobEvents(result.jobId,cursor);assert.equal(page.after,cursor);cursor=page.nextCursor;total+=page.events.length;dropped+=page.dropped;if(!page.hasMore)break;}while(true);
  assert.equal(cursor,result.lastSequence);assert.equal(total+dropped,result.lastSequence);assert.ok(dropped>0);assert.ok(total<=JOB_LIMITS.events);
  assert.throws(()=>host.getJobEvents(result.jobId,cursor+1),{code:'invalid_contract'});
  const forged=structuredClone(host.getJobEvents(result.jobId,0));forged.events[0].sequence++;assert.throws(()=>parseJobEvents(forged));
});
test('artifact grants, identity, content changes, private paths and post-cancel reads fail closed', async t => {
  for(const granted of [false,true]) {
    let content='original',reads=0;
    const {host,start}=await fixture(t,async(_,{job})=>{await job.addArtifact({id:'report',path:'report.txt'});return null;},{grants:granted?['workspace.read']:[],workspace:{readFile:async path=>{reads++;return{path,content,revision:sha(content)};}}});
    const job=await finished(host,start().jobId);
    if(!granted){assert.equal(job.error.code,'permission_denied');assert.equal(reads,0);continue;}
    content='replaced';await assert.rejects(host.readJobArtifact(job.jobId,'report'),{code:'conflict'});
  }
  for(const badPath of ['../secret','/absolute','nested/.env','NUL.txt']) {
    let reads=0;const {host,start}=await fixture(t,async(_,{job})=>{await job.addArtifact({id:'bad',path:badPath});return null;},{grants:['workspace.read'],workspace:{readFile:()=>{reads++;throw Error('must not read');}}});
    assert.equal((await finished(host,start().jobId)).state,'failed');assert.equal(reads,0);
  }
});
test('artifact reservations enforce the limit across concurrent reads and reject duplicates', async t => {
  const gate=deferred();let reservations;
  const {host,start}=await fixture(t,async(_,{job})=>{
    const pending=Array.from({length:JOB_LIMITS.artifacts},(_,i)=>job.addArtifact({id:`a${i}`,path:`a${i}.txt`}));
    await assert.rejects(job.addArtifact({id:'a0',path:'other.txt'}),{code:'conflict'});
    await assert.rejects(job.addArtifact({id:'extra',path:'extra.txt'}),{code:'budget_exceeded'});
    reservations=true;gate.resolve();await Promise.all(pending);return null;
  },{grants:['workspace.read'],workspace:{readFile:async path=>{await gate.promise;return{path,content:'x',revision:sha('x')};}}});
  const result=await finished(host,start().jobId);assert.equal(result.state,'succeeded');assert.equal(reservations,true);assert.equal(result.artifacts.length,JOB_LIMITS.artifacts);
});
test('job errors contain stable codes, never arbitrary provider messages or invalid results', async t => {
  for(const handler of [()=>{throw Error('private detail');},()=>({get secret(){throw Error('must not execute');}}),()=>undefined]) {
    const {host,start}=await fixture(t,handler);const result=await finished(host,start().jobId);
    assert.equal(result.state,'failed');assert.ok(!JSON.stringify(result).includes('private detail'));
    assert.throws(()=>parseJobSnapshot({...result,result:'forged'}));
  }
  let calls=0;const {host,start}=await fixture(t,async(_,{job})=>job.invokeBackend('tool',{}),{backends:{tool:()=>{calls++;return 1;}}});
  assert.equal((await finished(host,start().jobId)).error.code,'permission_denied');assert.equal(calls,0);
});
test('retained results have a bounded lifetime and count', async t => {
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const {host,start}=await fixture(t,()=>null);const ids=[];
  for(let i=0;i<JOB_LIMITS.retained;i++) {const result=await finished(host,start().jobId);ids.push(result.jobId);}
  assert.throws(()=>start(),{code:'budget_exceeded'});
  now+=JOB_LIMITS.retentionMs+1;assert.throws(()=>host.getJob(ids[0]),{code:'capability_unavailable'});
  assert.equal((await finished(host,start().jobId)).state,'succeeded');
});
test('nested backend operations cannot bypass limits by running without awaiting them', async t => {
  const gate=deferred(),issued=deferred();let calls=0;
  const {host,start}=await fixture(t,async(_,{job})=>{
    for(let i=0;i<JOB_LIMITS.operations;i++)void job.invokeBackend('tool',{});
    await assert.rejects(job.invokeBackend('tool',{}),{code:'budget_exceeded'});issued.resolve();return null;
  },{grants:['backend.invoke'],backends:{tool:async()=>{calls++;await gate.promise;return null;}}});
  const job=start();await issued.promise;assert.equal(calls,JOB_LIMITS.operations);assert.equal(host.getJob(job.jobId).state,'running');
  host.cancelJob(job.jobId);await delay(0);assert.equal(host.getJob(job.jobId).state,'cancelled');gate.resolve();
});
