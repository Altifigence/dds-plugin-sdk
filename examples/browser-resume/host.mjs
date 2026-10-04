import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {createNodeJobStore} from '@altifigence/dds-plugin-sdk/job-storage-node';
import {createNodeArtifactStore} from '@altifigence/dds-plugin-sdk/artifact-storage-node';

export async function createResumeFixture({fileBytes=2_097_169,allowedOrigins=[]}={}){
  assert.ok(Number.isSafeInteger(fileBytes)&&fileBytes>=0&&fileBytes<=16_777_233);
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-resume-example-'))),root=path.join(directory,'workspace'),workspaceId=randomUUID(),fixtureId=randomUUID(),jobId=randomUUID();
  let server,client,jobs,artifacts,config,closing,executions=0;
  async function stopHost(){client?.dispose();await server?.close();await artifacts?.close();await jobs?.close();client=server=artifacts=jobs=undefined;}
  const close=()=>closing??=(async()=>{await stopHost();assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir()));assert.ok(path.basename(directory).startsWith('dds-resume-example-'));await fs.rm(directory,{recursive:true});})();
  try{
    await fs.mkdir(root);const file=await fs.open(path.join(root,'trace.bin'),'wx'),hash=createHash('sha256'),block=Buffer.from(Array.from({length:65536},(_,n)=>(n*17+3)&255));
    try{for(let at=0;at<fileBytes;at+=block.length){const bytes=block.subarray(0,Math.min(block.length,fileBytes-at));await file.writeFile(bytes);hash.update(bytes);}await file.sync();}finally{await file.close();}
    const sha256=hash.digest('hex'),pluginId='browser-resume-example',artifactSha256=createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
    const plugin=definePlugin({manifestVersion:2,id:pluginId,name:'Browser checkpoint example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}},ctx=>ctx.registerCommand({id:'capture',title:'Capture selected fixture'},async(_,{job})=>{executions++;await job.addBinaryArtifact({id:'binary',path:'trace.bin'});return{};}));
    async function startHost({grants=['workspace.read']}={}){
      const token=randomBytes(32).toString('hex');
      jobs=await createNodeJobStore({directory:path.join(directory,'store'),workspaceRoot:root,workspaceId});artifacts=await createNodeArtifactStore({jobStore:jobs});
      server=await createWorkspaceServer({root,workspaceId,token,notice:{id:'resume-example',version:'1',text:'Explicit checkpoint and host-restart example.'},plugins:[{plugin,artifactSha256}],grants,jobs:true,binaryArtifacts:true,allowedOrigins,jobStorage:{store:jobs,artifacts}});
      client=createWorkspaceClient({url:server.url,token});await client.connect();config={fixtureId,url:server.url,token,pluginId,artifactSha256,jobId,artifactId:'binary',fileBytes,sha256,generation:client.binding.workspace.generation};
    }
    await startHost();await client.startCommandJob(pluginId,'capture',{},artifactSha256,{jobId});assert.equal((await client.waitForJob(jobId,{intervalMs:250})).state,'succeeded');
    // Live job completion can precede durable snapshot capture. Wait for the saved record.
    const deadline=Date.now()+30_000;
    for(;;){const recovery=await client.recoverJob(pluginId,jobId,artifactSha256);if(recovery.record?.settled)break;assert.ok(Date.now()<deadline,'Retained snapshot did not settle');await new Promise(resolve=>setTimeout(resolve,25));}
    await client.getStoredJobArtifact(pluginId,jobId,'binary',artifactSha256);await fs.unlink(path.join(root,'trace.bin'));
    return {directory,close,get client(){return client;},get config(){return {...config};},get executions(){return executions;},async restart(options){await stopHost();await startHost(options);return {...config};}};
  }catch(error){await close();throw error;}
}
