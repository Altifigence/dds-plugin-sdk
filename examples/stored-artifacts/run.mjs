import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {createNodeJobStore} from '@altifigence/dds-plugin-sdk/job-storage-node';
import {createNodeArtifactStore} from '@altifigence/dds-plugin-sdk/artifact-storage-node';
import {createWorkspaceServer,downloadStoredJobArtifact} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';

const artifactSha256='a'.repeat(64); // Fixture only; operators use a verified plugin package digest.
const manifest={manifestVersion:2,id:'stored-example',name:'Stored Results',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./run.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
if(process.argv[2]==='--worker'){
  const {root,directory,workspaceId,token}=JSON.parse(process.argv[3]);
  const store=await createNodeJobStore({directory,workspaceRoot:root,workspaceId}),artifacts=await createNodeArtifactStore({jobStore:store});
  const plugin=definePlugin(manifest,context=>context.registerCommand({id:'capture',title:'Capture',parameters:[{name:'reviewed',label:'Reviewed input',type:'boolean',required:true}]},async(input,{job})=>{
    if(!input.reviewed)throw Error('Review the input first');
    await job.addArtifact({id:'report',path:'report.txt'});await job.addBinaryArtifact({id:'trace',path:'trace.bin'});return{captured:true};
  }));
  const server=await createWorkspaceServer({root,workspaceId,token,jobs:true,binaryArtifacts:true,grants:['workspace.read'],plugins:[{plugin,artifactSha256}],jobStorage:{store,artifacts},notice:{id:'example',version:'1',text:'Disposable local result storage example.'}});
  process.send({url:server.url});
  let closing=false;
  process.on('message',async message=>{if(message!=='close'||closing)return;closing=true;try{await server.close();await artifacts.close();await store.close();process.disconnect();}catch{process.exitCode=1;process.disconnect();}});
}else{
  const temporary=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'dds-stored-example-'))),root=path.join(temporary,'project'),directory=path.join(temporary,'store'),workspaceId=randomUUID(),token=randomBytes(32).toString('hex');
  await fs.mkdir(root);const bytes=Buffer.alloc(196_731,173),report='A retained text result 보관 결과\n';
  await fs.writeFile(path.join(root,'trace.bin'),bytes);await fs.writeFile(path.join(root,'report.txt'),report);
  const children=[],clients=[];
  async function worker(){
    const child=fork(fileURLToPath(import.meta.url),['--worker',JSON.stringify({root,directory,workspaceId,token})],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});children.push(child);
    let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<4096)stderr+=chunk.toString();});
    const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
    const ready=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Example worker timeout')),15000);child.once('message',message=>{clearTimeout(timer);resolve(message);});child.once('exit',()=>{clearTimeout(timer);reject(Error('Example worker exited: '+stderr));});child.once('error',reject);});
    const client=createWorkspaceClient({url:ready.url,token});clients.push(client);await client.connect();
    return{client,async close(){client.dispose();child.send('close');assert.equal(await exited,0,stderr);}};
  }
  async function settled(client,id){const deadline=Date.now()+10000;for(;;){const recovery=await client.recoverJob(manifest.id,id,artifactSha256);if(recovery.record?.settled){assert.equal(recovery.record.snapshot.state,'succeeded');return recovery;}if(Date.now()>deadline)throw Error('Result checkpoint timeout');await delay(5);}}
  try{
    const first=await worker(),jobId=randomUUID();await first.client.startCommandJob(manifest.id,'capture',{reviewed:true},artifactSha256,{jobId});await settled(first.client,jobId);
    const reference=await first.client.getStoredJobArtifact(manifest.id,jobId,'trace',artifactSha256),destination=path.join(temporary,'downloaded-trace.bin'),controller=new AbortController();
    await assert.rejects(downloadStoredJobArtifact(first.client,reference,{destination,signal:controller.signal,onProgress:p=>{if(p.receivedBytes>=65536)controller.abort();}}),{code:'cancelled'});
    await first.close();await fs.unlink(path.join(root,'trace.bin'));await fs.unlink(path.join(root,'report.txt'));
    const second=await worker(),fresh=await second.client.getStoredJobArtifact(manifest.id,jobId,'trace',artifactSha256);
    assert.notEqual(fresh.scope.sessionId,reference.scope.sessionId);assert.equal(fresh.snapshot.snapshotId,reference.snapshot.snapshotId);
    await assert.rejects(second.client.readStoredJobArtifactChunk(reference,0),{code:'generation_mismatch'});
    const receipt=await downloadStoredJobArtifact(second.client,fresh,{destination,resume:true});assert.equal(receipt.verified,true);assert.equal(receipt.resumedBytes,65536);assert.deepEqual(await fs.readFile(destination),bytes);
    const text=await second.client.getStoredJobArtifact(manifest.id,jobId,'report',artifactSha256);assert.equal((await second.client.readStoredJobArtifactText(text)).content,report);
    const history=await second.client.listJobHistory(manifest.id,artifactSha256);assert.equal(history.items[0].resultAvailability,'snapshot-references');
    // Explicitly supply a new input/ID and new fixture source files for a new attempt.
    await fs.writeFile(path.join(root,'trace.bin'),Buffer.from('new result'));await fs.writeFile(path.join(root,'report.txt'),'new report');
    const retryId=randomUUID();await second.client.retryCommandJob(manifest.id,jobId,{reviewed:true},artifactSha256,{jobId:retryId});await settled(second.client,retryId);
    assert.equal((await second.client.listJobHistory(manifest.id,artifactSha256,{attemptOf:jobId})).items[0].jobId,retryId);
    assert.equal((await second.client.readStoredJobArtifactText(text)).content,report);await second.close();
    console.log('Stored artifacts: process restart, source deletion, verified resumed download and explicit retry verified');
  }finally{
    for(const client of clients)client.dispose();
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));}
    assert.equal(path.dirname(temporary),await fs.realpath(tmpdir()));assert.ok(path.basename(temporary).startsWith('dds-stored-example-'));await fs.rm(temporary,{recursive:true});
  }
}
