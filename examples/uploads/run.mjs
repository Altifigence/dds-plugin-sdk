import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer,downloadJobBinaryArtifact} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {uploadFile} from '@altifigence/dds-plugin-sdk/uploads';
import {createNodeUploadSource} from '@altifigence/dds-plugin-sdk/uploads-node';

/** Disposable real HTTP upload, host restart, binary job reference and stored download. */
export async function runUploadExample({fileBytes=8_388_625}={}){
  assert.ok(Number.isSafeInteger(fileBytes)&&fileBytes>65536&&fileBytes<=33_554_432);
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-upload-example-'))),root=path.join(directory,'workspace'),input=path.join(directory,'selected.bin');let server,client;
  const started=performance.now(),rss=process.memoryUsage().rss;let writes=0,maxChunk=0;
  try{
    await fs.mkdir(root);const output=await fs.open(input,'wx'),hash=createHash('sha256'),block=Buffer.from(Array.from({length:65536},(_,n)=>(n*17+31)&255));
    try{for(let offset=0;offset<fileBytes;offset+=block.length){const bytes=block.subarray(0,Math.min(block.length,fileBytes-offset));await output.writeFile(bytes);hash.update(bytes);}await output.sync();}finally{await output.close();}
    const sha256=hash.digest('hex'),workspaceId=randomUUID(),token=randomBytes(32).toString('hex'),pluginId='upload-example';
    const plugin=definePlugin({manifestVersion:2,id:pluginId,name:'Upload example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','workspace.write'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}},ctx=>ctx.registerCommand({id:'collect',title:'Collect uploaded input'},async(_,{job})=>{await job.addBinaryArtifact({id:'input',path:'input.bin'});return{artifact:'input'};}));
    // A source-example pin only; real operators pin their reviewed plugin archive.
    const artifactSha256=createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
    const options={root,workspaceId,token,plugins:[{plugin,artifactSha256}],grants:['workspace.read','workspace.write'],jobs:true,binaryArtifacts:true,timeoutMs:30000,uploads:{directory:path.join(directory,'staging'),principalId:'example-operator',roots:[''],fileSystem:'local'},notice:{id:'upload-example',version:'1',text:'Disposable selected-file transfer example; no external tools or services.'}};
    const connect=async()=>{server=await createWorkspaceServer(options);client=createWorkspaceClient({url:server.url,token,timeoutMs:30000,fetch:async(url,request)=>{const r=JSON.parse(request.body);if(r.method==='uploads.write'){writes++;maxChunk=Math.max(maxChunk,Buffer.from(r.params.chunk.data,'base64').length);}return fetch(url,request);}});await client.connect();};
    await connect();const source=await createNodeUploadSource({path:input}),selection={uploadId:randomUUID(),pluginId,artifactSha256,path:'input.bin',expectedRevision:null},abort=new AbortController();
    await assert.rejects(uploadFile(client,source,{...selection,signal:abort.signal,onProgress:update=>{if(update.phase==='uploading')abort.abort();}}),{code:'cancelled'});
    const partial=await client.queryUpload({uploadId:selection.uploadId,pluginId,artifactSha256});assert.equal(partial.offset,65536);assert.deepEqual((await client.listFiles()).entries,[]);
    client.dispose();await server.close();await connect();const receipt=await uploadFile(client,source,{...selection,recover:true});assert.equal(receipt.state,'committed');assert.equal(receipt.commitReceipt.revision,sha256);
    const job=await client.startCommandJob(pluginId,'collect',{},artifactSha256,{jobId:randomUUID()});assert.equal((await client.waitForJob(job.jobId,{intervalMs:250})).state,'succeeded');const reference=await client.getJobBinaryArtifact(job.jobId,'input');
    const download=await downloadJobBinaryArtifact(client,reference,{destination:path.join(directory,'downloaded.bin')});assert.equal(download.verified,true);assert.equal(download.revision,sha256);assert.equal(download.byteLength,fileBytes);assert.equal(writes,Math.ceil(fileBytes/65536));
    return{node:process.version,fileBytes,uploadChunks:writes,maxDecodedChunk:maxChunk,resumedBytes:partial.offset,uploadSha256:receipt.commitReceipt.revision,downloadSha256:download.revision,storedDownloadVerified:download.verified,peakQueuedChunks:1,rssDeltaBytes:Math.max(0,process.memoryUsage().rss-rss),elapsedMs:Number((performance.now()-started).toFixed(2))};
  }finally{client?.dispose();await server?.close();assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir()));assert.ok(path.basename(directory).startsWith('dds-upload-example-'));await fs.rm(directory,{recursive:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runUploadExample(),null,2));
