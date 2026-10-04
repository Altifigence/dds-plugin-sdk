import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {createPluginHost, definePlugin} from '@altifigence/dds-plugin-sdk';
import {createNodeJobStore} from '@altifigence/dds-plugin-sdk/job-storage-node';

const artifactSha256 = 'a'.repeat(64); // Synthetic fixture only; operators pin the verified package digest.
const plugin = definePlugin({manifestVersion:2,id:'durable-example',name:'Durable Example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./run.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read'],supportedHosts:['test-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}}, context => context.registerCommand({id:'work',title:'Work'}, async (input,{job}) => {
  job.log('info', 'Synthetic progress'); job.reportProgress({completed:1,total:2});
  if (input.wait) await new Promise(() => {});
  return {done:true};
}));
function hostFor(store, sessionId) {
  return createPluginHost({jobs:true,scope:{projectId:store.identity.workspaceId,sessionId},grants:['workspace.read'],jobStorage:{store,workspaceIdentity:store.identity.workspaceIdentity,pluginArtifacts:{[plugin.manifest.id]:artifactSha256}}});
}
if (process.argv[2] === '--worker') {
  const {directory,workspaceRoot,workspaceId,jobId,wait} = JSON.parse(process.argv[3]);
  const store = await createNodeJobStore({directory,workspaceRoot,workspaceId});
  const host = hostFor(store,randomUUID()); await host.activate(plugin);
  host.startCommandJob(plugin.manifest.id,'work',{wait},{jobId});
  // Wait for a recorded progress event, or for the complete terminal checkpoint.
  const deadline = Date.now()+10_000;
  for (;;) {
    await host.flushJobStore(); const current = host.recoverJob(plugin.manifest.id,jobId);
    if (wait ? current.record?.snapshot.progress?.completed === 1 : current.record?.settled) break;
    if (Date.now()>deadline) throw Error('Checkpoint timeout'); await delay(5);
  }
  process.send({jobId});
  if (wait) setInterval(()=>{},1000); // The parent terminates only this test-owned child.
  else {host.dispose();await host.flushJobStore();await store.close();process.disconnect();}
} else {
  const root = await realpath(await mkdtemp(path.join(tmpdir(),'dds-durable-example-'))), workspaceRoot = path.join(root,'project'), directory = path.join(root,'store'), workspaceId = randomUUID();
  await mkdir(workspaceRoot); const children = []; let store, host;
  async function runWorker(wait) {
    const jobId=randomUUID(), child=fork(fileURLToPath(import.meta.url),['--worker',JSON.stringify({directory,workspaceRoot,workspaceId,jobId,wait})],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true}); children.push(child);
    let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<4096)stderr+=chunk.toString();});
    const exit = new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
    const ready = new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Child checkpoint timeout')),15_000);child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Child exited before checkpoint: '+stderr));});child.once('error',reject);});
    assert.equal((await ready).jobId,jobId);
    if(wait)child.kill('SIGKILL'); const result=await exit;
    if(!wait)assert.equal(result.code,0,stderr);
    return jobId;
  }
  try {
    const completed=await runWorker(false), interrupted=await runWorker(true);
    await assert.rejects(createNodeJobStore({directory,workspaceRoot,workspaceId}),{code:'conflict'});
    store=await createNodeJobStore({directory,workspaceRoot,workspaceId,recoverStaleLock:true});
    host=hostFor(store,randomUUID());await host.activate(plugin);
    const success=host.recoverJob(plugin.manifest.id,completed), stopped=host.recoverJob(plugin.manifest.id,interrupted);
    assert.equal(success.disposition,'completed');assert.equal(success.unrecordedTail,'none');
    assert.equal(stopped.disposition,'interrupted');assert.equal(stopped.unrecordedTail,'unknown');assert.equal(stopped.record.snapshot.state,'running');
    assert.throws(()=>host.startCommandJob(plugin.manifest.id,'work',{wait:true},{jobId:interrupted}),{code:'conflict'});
    console.log('Durable jobs: clean shutdown, killed child, current authorization and no automatic replay verified');
  } finally {
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
    host?.dispose();await host?.flushJobStore();await store?.close();
    assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith('dds-durable-example-'));
    await rm(root,{recursive:true});
  }
}
