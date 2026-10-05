import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPluginHost,definePlugin} from '../src/index.mjs';
import {prepareWorkflowPlan,createWorkflowRunner,createMemoryWorkflowStore,createCommandJobExecutor,recoverWorkflowRecord,parseWorkflowRecord} from '../src/workflows.mjs';
import {createNodeWorkflowStore} from '../src/workflows-node.mjs';

const number={type:'integer',minimum:0,maximum:1000},data={schemaVersion:1,schema:{type:'object',properties:{value:number},required:['value'],additionalProperties:false}};
const commands=[{id:'increment',pluginId:'workflow-example',pluginSha256:'a'.repeat(64),inputSchema:data,outputSchema:data,grants:[]}];
const binding={workspaceId:'w',securityScope:'owner'};
const step=(id,needs=[],value=1)=>({id,commandId:'increment',needs,input:{value:needs.length?{step:needs[0],path:['value']}:{value}},grants:[]});
const definition=steps=>({schemaVersion:1,id:'build',scope:binding,steps,policy:'continue',concurrency:2,timeoutMs:1000,stepTimeoutMs:500,retentionMs:1000});
const approve=plan=>({approved:true,planSha256:plan.sha256});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const code=expected=>e=>e.code===expected;
async function temporary(fn){const parent=await realpath(await mkdtemp(path.join(tmpdir(),'dds-workflow-test-')));try{await mkdir(path.join(parent,'workspace'));await mkdir(path.join(parent,'store'));await fn(parent);}finally{assert.equal(path.dirname(parent),await realpath(tmpdir()));assert.ok(path.basename(parent).startsWith('dds-workflow-test-'));await rm(parent,{recursive:true});}}

test('workflow preflight rejects cycles, schema mismatches, unknown/duplicate commands, missing bindings and secret fields before execution',()=>{
  const valid=definition([step('a'),step('b',['a'])]);assert.ok(Object.isFrozen(prepareWorkflowPlan(valid,commands)));
  const bads=[];
  for(const modify of [d=>d.steps[0].needs.push('b'),d=>d.steps[1].input.value.step='absent',d=>d.steps.push(step('a')),d=>d.steps[0].commandId='unknown',d=>delete d.steps[0].input.value,d=>d.steps[0].input.value.value='bad',d=>d.concurrency=9,d=>d.steps[1].input.value.path=['missing']]){const d=structuredClone(valid);modify(d);bads.push(d);}
  bads.forEach(d=>assert.throws(()=>prepareWorkflowPlan(d,commands)));
  assert.throws(()=>prepareWorkflowPlan(valid,[...commands,...commands]));
  const changed=structuredClone(commands);changed[0].outputSchema.schema.properties.value.type='string';delete changed[0].outputSchema.schema.properties.value.minimum;delete changed[0].outputSchema.schema.properties.value.maximum;assert.throws(()=>prepareWorkflowPlan(valid,changed));
  const sensitive=structuredClone(commands);sensitive[0].inputSchema.schema.properties.value={type:'object',format:'dds-secret-reference'};assert.throws(()=>prepareWorkflowPlan(valid,sensitive),code('UNSUPPORTED'));
});

test('workflow schedules bounded branches and executes through the existing public command-job host',async()=>{
  let active=0,peak=0;const hostScope={projectId:'w',sessionId:'owner'},host=createPluginHost({jobs:true,grants:[],scope:hostScope});
  const plugin=definePlugin({manifestVersion:2,id:'workflow-example',name:'Workflow',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./run.mjs',runtime:'workspace',capabilities:['commands'],permissions:[],supportedHosts:['test-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}},context=>context.registerCommand({id:'increment',title:'Increment'},async(input,{job})=>{active++;peak=Math.max(peak,active);await delay(10);job.reportProgress({completed:1,total:1});active--;return {value:input.value+1};}));
  try{
    await host.activate(plugin);const seen=[];
    const runner=createWorkflowRunner({commands,authorize:c=>{seen.push(c);return true;},execute:createCommandJobExecutor({resolveHost:async({grants})=>{assert.deepEqual(grants,[]);return {host,scope:hostScope,grants,pluginSha256:commands[0].pluginSha256};}})});
    const plan=prepareWorkflowPlan(definition([step('a'),step('b'),step('c',['a']),step('d',['b'])]),commands);
    const result=await runner.run(plan,{approval:approve(plan),parentJobId:'parent-job'});
    assert.equal(result.state,'succeeded');assert.equal(result.parentJobId,'parent-job');assert.equal(result.steps[2].output.value,3);assert.equal(peak,2);
    assert.ok(result.steps.every(s=>s.jobId&&s.reason==='EXECUTED'));assert.deepEqual(runner.inspect(),{running:false,unsettled:0});assert.ok(seen.every(s=>s.grants.length===0));
  }finally{host.dispose();}
});

test('workflow failure blocks only dependent branches; manual resume reuses approved successes in a new attempt',async()=>{
  const store=createMemoryWorkflowStore();let fail=true,calls=[];
  const runner=createWorkflowRunner({commands,store,authorize:()=>true,execute:async(s,_,input)=>{calls.push(s.id);if(s.id==='b'&&fail)throw Error('Synthetic failure');return {output:{value:input.value+1}};}});
  const plan=prepareWorkflowPlan(definition([step('a'),step('b',['a']),step('c',['b']),step('d')]),commands);
  const first=await runner.run(plan,{approval:approve(plan)});assert.equal(first.state,'failed');assert.deepEqual(first.steps.map(s=>s.state),['succeeded','failed','blocked','succeeded']);
  fail=false;calls=[];
  const second=await runner.run(plan,{approval:{...approve(plan),previousAttemptId:first.attemptId},previous:first});
  assert.equal(second.state,'succeeded');assert.notEqual(second.attemptId,first.attemptId);assert.equal(second.parentAttemptId,first.attemptId);assert.deepEqual(calls,['b','c']);assert.equal(second.steps[0].sourceAttemptId,first.attemptId);
  const changed=structuredClone(commands);changed[0].pluginSha256='b'.repeat(64);
  await assert.rejects(createWorkflowRunner({commands:changed,authorize:()=>true,execute:async()=>{throw Error('must not execute');}}).run(plan,{approval:approve(plan)}),code('CONFLICT'));
  await assert.rejects(runner.run(plan,{approval:{...approve(plan),planSha256:'0'.repeat(64)}}),code('DENIED'));
});

test('workflow grants are checked at each stage, expired partial outputs require selected retries, and retry propagates through unordered DAG',async()=>{
  let now=1,allowed=true,calls=0;const store=createMemoryWorkflowStore();
  const runner=createWorkflowRunner({commands,store,now:()=>now,authorize:()=>allowed,execute:async(_,__,input)=>{calls++;return {output:{value:input.value+1}};}});
  const plan=prepareWorkflowPlan(definition([step('c',['b']),step('b',['a']),step('a')]),commands);
  const first=await runner.run(plan,{approval:approve(plan)});assert.equal(calls,3);now=2000;
  const expired=await runner.run(plan,{approval:{...approve(plan),previousAttemptId:first.attemptId},previous:first});assert.equal(expired.state,'failed');assert.equal(expired.steps[2].reason,'EXPIRED');
  const fresh=await runner.run(plan,{approval:{...approve(plan),previousAttemptId:first.attemptId,retrySteps:['a']},previous:first});assert.equal(fresh.state,'succeeded');assert.equal(calls,6);
  allowed=false;const denied=await runner.run(plan,{approval:approve(plan)});assert.equal(denied.state,'failed');assert.equal(calls,6);assert.ok(denied.steps.every(s=>s.output===null));
});

test('workflow cancel, step deadline, fail-fast and unsettled handlers retain truthful states and prevent overlapping retries',async()=>{
  let settle;const pending=new Promise(r=>{settle=r;});const controller=new AbortController();let entered;const ready=new Promise(r=>{entered=r;});
  const runner=createWorkflowRunner({commands,authorize:()=>true,execute:async()=>{entered();return pending;}});
  const plan=prepareWorkflowPlan(definition([step('a')]),commands);
  const running=runner.run(plan,{approval:approve(plan),signal:controller.signal});await ready;controller.abort();const stopped=await running;
  assert.equal(stopped.steps[0].state,'cancelled');assert.equal(stopped.state,'cancelled');assert.equal(runner.inspect().unsettled,1);
  await assert.rejects(runner.run(plan,{approval:approve(plan)}),code('CONFLICT'));settle({output:{value:2}});await delay(0);assert.equal(runner.inspect().unsettled,0);
  const timeoutPlan=prepareWorkflowPlan({...definition([step('a')]),stepTimeoutMs:5},commands);
  const timeout=createWorkflowRunner({commands,authorize:()=>true,execute:async()=>{await delay(20);return {output:{value:2}};}});
  const timed=await timeout.run(timeoutPlan,{approval:approve(timeoutPlan)});assert.equal(timed.steps[0].state,'timed_out');await delay(25);
  const failurePlan=prepareWorkflowPlan({...definition([step('a'),step('b',['a'])]),policy:'fail-fast'},commands);
  const failed=await createWorkflowRunner({commands,authorize:()=>true,execute:async()=>{throw Error('failure');}}).run(failurePlan,{approval:approve(failurePlan)});assert.equal(failed.state,'failed');assert.equal(failed.steps[1].state,'cancelled');
});

test('durable workflow checkpoints survive restart without automatic execution; CAS, corruption and owned cleanup preserve workspace files',async()=>temporary(async parent=>{
  const options={directory:path.join(parent,'store'),workspaceRoot:path.join(parent,'workspace'),scope:binding};let store=await createNodeWorkflowStore(options);
  const plan=prepareWorkflowPlan(definition([step('a')]),commands);let count=0;
  const runner=createWorkflowRunner({commands,store,authorize:()=>true,execute:async()=>{count++;return {output:{value:2}};}});
  const first=await runner.run(plan,{approval:approve(plan)});await store.close();store=await createNodeWorkflowStore(options);
  assert.deepEqual(await store.read(first.attemptId),first);assert.equal(count,1);
  const running=structuredClone(first);running.attemptId='interrupted';running.revision=1;running.state='running';Object.assign(running.steps[0],{state:'running',output:null,outputSha256:null,artifacts:[]});await store.write(running,0);
  const recovered=recoverWorkflowRecord(await store.read('interrupted'));assert.equal(recovered.state,'interrupted');assert.equal(recovered.steps[0].state,'interrupted');assert.equal(count,1);
  await assert.rejects(store.write(running,0),code('CONFLICT'));
  const expired=structuredClone(first);expired.attemptId='expired';expired.revision=1;expired.expiresAt=expired.startedAt+1;await store.write(expired,0);
  const retention=await store.cleanup({expiredBefore:expired.expiresAt});assert.ok(retention.removed.includes('expired.json'));assert.equal(await store.read('expired'),null);assert.ok(await store.read('interrupted'));
  await writeFile(path.join(parent,'workspace','keep.txt'),'retain');await store.close();
  await writeFile(path.join(parent,'store','unknown.txt'),'retain');await writeFile(path.join(parent,'store',first.attemptId+'.json'),'broken');
  store=await createNodeWorkflowStore(options);assert.equal(await store.read(first.attemptId),null);const cleaned=await store.cleanup();assert.ok(cleaned.removed.includes(first.attemptId+'.json'));assert.ok(cleaned.preserved.includes('unknown.txt'));assert.equal(await readFile(path.join(parent,'workspace','keep.txt'),'utf8'),'retain');await store.close();
  assert.throws(()=>parseWorkflowRecord({...first,steps:[{...first.steps[0],outputSha256:'0'.repeat(64)}]}));
}));

test('concurrent manual resumes cannot enter while another resume owns the runner',async()=>{
  const records=createMemoryWorkflowStore();let release,waiting=false;
  const store={...records,async read(id){if(waiting)await new Promise(resolve=>{release=resolve;});return records.read(id);}};
  const runner=createWorkflowRunner({commands,store,authorize:()=>true,execute:async(_,__,input)=>({output:{value:input.value+1}})});
  const plan=prepareWorkflowPlan(definition([step('a')]),commands),previous=await runner.run(plan,{approval:approve(plan)});
  waiting=true;const resume=runner.run(plan,{previous,approval:{...approve(plan),previousAttemptId:previous.attemptId}});
  waiting=false;let entered;const ready=new Promise(resolve=>{entered=resolve;});let unblock;
  const originalWrite=store.write;store.write=async(...args)=>{entered();await new Promise(resolve=>{unblock=resolve;});return originalWrite(...args);};
  const first=runner.run(plan,{approval:approve(plan)});await ready;release();await assert.rejects(resume,code('CONFLICT'));
  store.write=originalWrite;unblock();assert.equal((await first).state,'succeeded');
});
