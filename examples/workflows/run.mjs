import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createPluginHost,definePlugin} from '@altifigence/dds-plugin-sdk';
import {prepareWorkflowPlan,createWorkflowRunner,createCommandJobExecutor} from '@altifigence/dds-plugin-sdk/workflows';
import {createNodeWorkflowStore} from '@altifigence/dds-plugin-sdk/workflows-node';
import {fingerprintWorkflowInputs,createWorkflowCache} from '@altifigence/dds-plugin-sdk/workflow-cache';
import {createNodeWorkflowCacheStore} from '@altifigence/dds-plugin-sdk/workflow-cache-node';
import {scope,pluginSha256,commands,definition,recoveryDefinition} from './fixture.mjs';

const parent=await realpath(await mkdtemp(path.join(tmpdir(),'dds-workflow-example-'))),workspaceRoot=path.join(parent,'workspace');
let store,cacheStore,cache,host,child;
try{
  for(const name of ['workspace','workflows','cache','recovery'])await mkdir(path.join(parent,name));
  await writeFile(path.join(workspaceRoot,'left.txt'),'alpha');await writeFile(path.join(workspaceRoot,'right.txt'),'beta');
  const hostScope={projectId:'example',sessionId:'operator'},executed=[];
  host=createPluginHost({jobs:true,grants:[],scope:hostScope});
  await host.activate(definePlugin({manifestVersion:2,id:'workflow-example',name:'Workflow example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./run.mjs',runtime:'workspace',capabilities:['commands'],permissions:[],supportedHosts:['test-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}},context=>{
    context.registerCommand({id:'measure',title:'Measure an example file'},async input=>{
      assert.ok(['left.txt','right.txt'].includes(input.source));executed.push(input.source);
      const contents=await readFile(path.join(workspaceRoot,input.source),'utf8');if(contents==='FAIL')throw Error('Requested example failure');
      return {value:contents.length};
    });
    context.registerCommand({id:'combine',title:'Add measurements'},input=>{executed.push('sum');return {value:input.left+input.right};});
  }));
  const storeOptions={directory:path.join(parent,'workflows'),workspaceRoot,scope};
  store=await createNodeWorkflowStore(storeOptions);
  cacheStore=await createNodeWorkflowCacheStore({directory:path.join(parent,'cache'),workspaceRoot,scope});
  cache=createWorkflowCache({store:cacheStore,authorize:()=>true,ttlMs:60000});
  const execute=createCommandJobExecutor({resolveHost:({grants})=>({host,scope:hostScope,grants,pluginSha256})});
  const runner=createWorkflowRunner({commands,store,authorize:()=>true,execute:async(step,command,input,context)=>{
    const files=command.id==='measure'?[{path:input.source,bytes:await readFile(path.join(workspaceRoot,input.source))}]:[];
    const fingerprint=fingerprintWorkflowInputs({scope,commandId:command.id,pluginSha256,toolSha256:null,schema:command,settings:{},environment:{declared:[],values:{}},input,files,grants:step.grants,policy:{optIn:true,deterministic:true,declaredInputsComplete:true,secretDependent:false}});
    const result=await cache.run(fingerprint,{signal:context.signal,compute:async({signal})=>(await execute(step,command,input,{...context,signal})).output});
    return {output:result.value,cache:{key:fingerprint.key,state:result.state,reason:result.reason}};
  }});
  const plan=prepareWorkflowPlan(definition,commands),options={approval:{approved:true,planSha256:plan.sha256}};
  let started=performance.now();const first=await runner.run(plan,options),firstMs=performance.now()-started;assert.equal(first.state,'succeeded');assert.equal(first.steps[2].output.value,9);assert.equal(executed.length,3);
  executed.length=0;started=performance.now();const repeated=await runner.run(plan,options),hitMs=performance.now()-started;assert.equal(executed.length,0);assert.ok(repeated.steps.every(s=>s.cache.state==='hit'&&s.jobId===null));
  await writeFile(path.join(workspaceRoot,'left.txt'),'changed');const incremental=await runner.run(plan,options);
  assert.deepEqual(executed,['left.txt','sum']);assert.deepEqual(incremental.steps.map(s=>s.cache.state),['miss','hit','miss']);assert.equal(incremental.steps[2].output.value,11);
  // A cached parent never runs before its dependencies have succeeded in this attempt.
  executed.length=0;await writeFile(path.join(workspaceRoot,'left.txt'),'FAIL');const failed=await runner.run(plan,options);
  assert.deepEqual(failed.steps.map(s=>s.state),['failed','succeeded','blocked']);assert.deepEqual(executed,['left.txt']);assert.equal(failed.steps[2].cache,null);
  await store.close();store=await createNodeWorkflowStore(storeOptions);assert.deepEqual(await store.read(incremental.attemptId),incremental);
  const metrics={firstMs,hitMs,cache:cache.inspect(),storedBytes:cacheStore.inspect().bytes};
  await cache.close();cache=null;await cacheStore.close();cacheStore=null;await store.close();store=null;host.dispose();host=null;

  const recoveryOptions={directory:path.join(parent,'recovery'),workspaceRoot,scope};
  child=spawn(process.execPath,[fileURLToPath(new URL('./interrupted-child.mjs',import.meta.url)),JSON.stringify(recoveryOptions)],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  let timeout;const exited=once(child,'exit');let ready;
  try{[ready]=await Promise.race([once(child,'message'),exited.then(()=>{throw Error('Example child exited before checkpoint');}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Checkpoint timeout')),10000);})]);}finally{clearTimeout(timeout);}
  assert.equal(ready.ready,true);child.kill('SIGKILL');await exited;child=null;
  await assert.rejects(createNodeWorkflowStore(recoveryOptions),error=>error.code==='CONFLICT');
  store=await createNodeWorkflowStore({...recoveryOptions,recoverStaleLock:true});let retries=0;
  const resumedRunner=createWorkflowRunner({commands,store,authorize:()=>true,execute:async()=>{retries++;return {output:{value:20}};}});
  const interrupted=await resumedRunner.recover(ready.attemptId);assert.equal(interrupted.state,'interrupted');assert.deepEqual(interrupted.steps.map(s=>s.state),['succeeded','interrupted']);assert.equal(retries,0);
  const recoveryPlan=prepareWorkflowPlan(recoveryDefinition,commands);
  const resumed=await resumedRunner.run(recoveryPlan,{previous:interrupted,approval:{approved:true,planSha256:recoveryPlan.sha256,previousAttemptId:interrupted.attemptId}});
  assert.equal(resumed.state,'succeeded');assert.equal(retries,1);assert.equal(resumed.steps[0].reason,'REUSED');assert.equal(resumed.steps[0].sourceAttemptId,interrupted.attemptId);assert.notEqual(resumed.attemptId,interrupted.attemptId);
  console.log(JSON.stringify({verified:true,commandJobs:true,cacheHits:3,incrementalSteps:2,failedDependencyBlocked:true,killedChildRecovery:true,automaticReplay:false,explicitRetrySteps:retries,metrics}));
}finally{
  if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
  host?.dispose();await cache?.close();await cacheStore?.close();await store?.close();
  assert.equal(path.dirname(parent),await realpath(tmpdir()));assert.ok(path.basename(parent).startsWith('dds-workflow-example-'));await rm(parent,{recursive:true});
}
