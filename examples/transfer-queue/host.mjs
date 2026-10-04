import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';

export async function createQueueFixture({fileBytes=2_097_169,allowedOrigins=[]}={}){
  assert.ok(Number.isSafeInteger(fileBytes)&&fileBytes>65536&&fileBytes<=16_777_233);
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-queue-example-'))),root=path.join(directory,'workspace'),selectedFile=path.join(root,'large.bin');let server,client,closing;
  const close=()=>closing??=(async()=>{client?.dispose();await server?.close();assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir()));assert.ok(path.basename(directory).startsWith('dds-queue-example-'));await fs.rm(directory,{recursive:true});})();
  try{
    await fs.mkdir(path.join(root,'input'),{recursive:true});const handle=await fs.open(selectedFile,'wx'),hash=createHash('sha256'),block=Buffer.from(Array.from({length:65536},(_,n)=>(n*13+7)&255));
    try{for(let offset=0;offset<fileBytes;offset+=block.length){const bytes=block.subarray(0,Math.min(block.length,fileBytes-offset));await handle.writeFile(bytes);hash.update(bytes);}await handle.sync();}finally{await handle.close();}
    await fs.writeFile(path.join(root,'small.bin'),block.subarray(0,4096));const sha256=hash.digest('hex'),pluginId='queue-example',artifactSha256=createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),token=randomBytes(32).toString('hex');
    const plugin=definePlugin({manifestVersion:2,id:pluginId,name:'Transfer queue example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','workspace.write'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}},ctx=>ctx.registerCommand({id:'collect',title:'Collect example binary'},async(input,{job})=>{await job.addBinaryArtifact({id:'binary',path:input.path});return{};}));
    server=await createWorkspaceServer({root,workspaceId:randomUUID(),token,notice:{id:'queue-example',version:'1',text:'Disposable mixed-transfer example; explicitly selected files only.'},plugins:[{plugin,artifactSha256}],grants:['workspace.read','workspace.write'],jobs:true,binaryArtifacts:true,allowedOrigins,timeoutMs:30000,uploads:{directory:path.join(directory,'staging'),principalId:'example-operator',roots:['input'],fileSystem:'local'}});
    client=createWorkspaceClient({url:server.url,token,timeoutMs:30000});await client.connect();
    async function collect(file){const job=await client.startCommandJob(pluginId,'collect',{path:file},artifactSha256,{jobId:randomUUID()});assert.equal((await client.waitForJob(job.jobId,{intervalMs:250})).state,'succeeded');return client.getJobBinaryArtifact(job.jobId,'binary');}
    const large=await collect('large.bin'),small=await collect('small.bin');
    return{directory,root,selectedFile,close,client,config:{url:server.url,token,pluginId,artifactSha256,large,small,sha256,fileBytes}};
  }catch(error){await close();throw error;}
}
