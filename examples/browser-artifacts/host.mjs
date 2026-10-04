import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';

/** Disposable real file/HTTP fixture shared by independent Node and browser consumers. */
export async function createArtifactFixture({fileBytes=8_388_625,allowedOrigins=[]}={}){
  assert.ok(Number.isSafeInteger(fileBytes)&&fileBytes>=0&&fileBytes<=33_554_432);
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-stream-example-'))),root=path.join(directory,'workspace');
  let server,client;
  async function close(){client?.dispose();await server?.close();assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir()));assert.ok(path.basename(directory).startsWith('dds-stream-example-'));await fs.rm(directory,{recursive:true});}
  try{
    await fs.mkdir(root);const block=Buffer.from(Array.from({length:65536},(_,index)=>(index*31+17)&255)),hash=createHash('sha256'),file=await fs.open(path.join(root,'trace.bin'),'wx');
    try{for(let at=0;at<fileBytes;at+=block.length){const bytes=block.subarray(0,Math.min(block.length,fileBytes-at));await file.writeFile(bytes);hash.update(bytes);}}finally{await file.close();}
    const sha256=hash.digest('hex'),token=randomBytes(32).toString('hex'),pin=createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
    const manifest={manifestVersion:2,id:'stream-example',name:'Streaming result example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
    const plugin=definePlugin(manifest,context=>context.registerCommand({id:'collect',title:'Collect generated trace'},async(_,{job})=>{if(!job)throw new Error('Run as a job');await job.addBinaryArtifact({id:'trace',path:'trace.bin'});return{artifact:'trace'};}));
    server=await createWorkspaceServer({root,workspaceId:randomUUID(),token,jobs:true,binaryArtifacts:true,writable:false,grants:['workspace.read'],plugins:[{plugin,artifactSha256:pin}],notice:{id:'stream-example',version:'1',text:'Temporary stream example. Uses an explicitly chosen browser destination.'},allowedOrigins});
    client=createWorkspaceClient({url:server.url,token});await client.connect();const job=await client.startCommandJob(manifest.id,'collect',{},pin,{jobId:randomUUID()});assert.equal((await client.waitForJob(job.jobId,{intervalMs:250})).state,'succeeded');
    const reference=await client.getJobBinaryArtifact(job.jobId,'trace');assert.equal(reference.artifact.revision,sha256);
    return{directory,client,config:{url:server.url,token,reference,fileBytes,sha256},close};
  }catch(error){await close();throw error;}
}
