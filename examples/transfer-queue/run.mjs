import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {createQueueFixture} from './host.mjs';
import {createTransferQueue} from '@altifigence/dds-plugin-sdk/transfer-queue';
import {createNodeUploadSource} from '@altifigence/dds-plugin-sdk/uploads-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';

// A trusted sink for this disposable example directory; it keeps only one chunk.
function fileSink(destination){return{capabilities:{kind:'caller',seek:true,readback:true,persistence:'per-checkpoint',abort:'retain'},async open(){
  let handle=await fs.open(destination,'wx+');const close=async()=>{await handle?.close();handle=undefined;};
  return{async write({offset,bytes}){for(let at=0;at<bytes.length;){const result=await handle.write(bytes,at,bytes.length-at,offset+at);assert.ok(result.bytesWritten);at+=result.bytesWritten;}},async commit(){await handle.sync();},abort:close,close,
    async readback(){return{byteLength:(await handle.stat()).size,async read(offset,length){const bytes=new Uint8Array(length),result=await handle.read(bytes,0,length,offset);return bytes.subarray(0,result.bytesRead);}};},};
}};}
export async function runQueueExample({fileBytes=2_097_169}={}){
  const fixture=await createQueueFixture({fileBytes}),q=createTransferQueue({concurrency:2,perConnection:2,bufferBytes:131072,baseDelayMs:30,maxDelayMs:100}),started=performance.now(),baseline=process.memoryUsage().rss,lag=monitorEventLoopDelay({resolution:10});
  let peak=baseline,lostWrite=false,rejectedRead=false,paused=false,upload,client;const finished={},sampler=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},10);lag.enable();
  try{
    const c=fixture.config;client=createWorkspaceClient({url:c.url,token:c.token,timeoutMs:30000,fetch:async(url,options)=>{
      const request=JSON.parse(options.body);if(request.method==='artifacts.read'&&!rejectedRead){rejectedRead=true;return new Response('',{status:503});}
      const response=await fetch(url,options);if(request.method==='uploads.write'&&!lostWrite){lostWrite=true;await response.json();throw Error('Disposable lost acknowledgement fixture');}return response;
    }});await client.connect();
    q.subscribe(s=>{if(s.id===upload?.id&&!paused&&s.phase==='uploading'&&s.acknowledgedBytes>=65536){paused=true;upload.pause();setTimeout(()=>upload.resume(),100);}});
    const large=q.enqueueDownload(client,c.large,{sink:fileSink(path.join(fixture.directory,'large-download.bin'))});
    upload=q.enqueueUpload(client,await createNodeUploadSource({path:fixture.selectedFile}),{uploadId:randomUUID(),pluginId:c.pluginId,artifactSha256:c.artifactSha256,path:'input/selected.bin',expectedRevision:null});
    const small=q.enqueueDownload(client,c.small,{sink:fileSink(path.join(fixture.directory,'small-download.bin'))});
    for(const [name,h]of Object.entries({large,small,upload}))h.result.then(()=>{finished[name]=Number((performance.now()-started).toFixed(2));});
    const [download,committed]=await Promise.all([large.result,upload.result,small.result]);assert.equal(download.storedSha256,c.sha256);assert.equal(committed.commitReceipt.revision,c.sha256);assert.ok(finished.small<finished.large);assert.ok(paused);assert.equal(upload.snapshot.retriedBytes,65536);assert.equal(large.snapshot.retriedBytes,65536);
    return{node:process.version,fileBytes,verified:true,pausedAndResumed:paused,smallFinishedBeforeLarge:finished.small<finished.large,finishedMs:finished,upload:upload.snapshot,download:large.snapshot,queue:q.inspect(),rssDeltaBytes:Math.max(0,peak-baseline),eventLoopMaxMs:Number((lag.max/1e6).toFixed(2)),elapsedMs:Number((performance.now()-started).toFixed(2))};
  }finally{clearInterval(sampler);lag.disable();await q.dispose();client?.dispose();await fixture.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runQueueExample(),null,2));
