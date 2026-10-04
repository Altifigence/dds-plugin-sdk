import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {streamJobBinaryArtifact} from '@altifigence/dds-plugin-sdk/artifact-transfer';
import {createArtifactFixture} from './host.mjs';

export async function runStreamingArtifactExample({fileBytes=2_097_169}={}){
  const fixture=await createArtifactFixture({fileBytes}),destination=path.join(fixture.directory,'download.bin');
  const baseline=process.memoryUsage().rss;let peak=baseline,handle;
  const sampling=setInterval(()=>{peak=Math.max(peak,process.memoryUsage().rss);},10),lag=monitorEventLoopDelay({resolution:10});lag.enable();
  try{
    const sink={capabilities:{kind:'caller',seek:true,readback:true,persistence:'per-checkpoint',abort:'retain'},async open(){
      handle=await fs.open(destination,'wx+');return{
        async write({offset,bytes}){let at=0;while(at<bytes.length){const result=await handle.write(bytes,at,bytes.length-at,offset+at);assert.ok(result.bytesWritten>0);at+=result.bytesWritten;}},
        async commit(){await handle.sync();},async abort(){await handle?.close();handle=undefined;},async close(){await handle?.close();handle=undefined;},
        async readback(){return{byteLength:(await handle.stat()).size,async read(offset,length){const bytes=new Uint8Array(length);const result=await handle.read(bytes,0,length,offset);return bytes.subarray(0,result.bytesRead);}};},
      };
    }};
    const receipt=await streamJobBinaryArtifact(fixture.client,fixture.config.reference,{sink});assert.equal(receipt.verification,'stored');assert.equal(receipt.storedSha256,fixture.config.sha256);assert.equal((await fs.stat(destination)).size,fileBytes);
    return{node:process.version,fileBytes,...receipt.metrics,receivedSha256:receipt.receivedSha256,storedSha256:receipt.storedSha256,rssDeltaBytes:Math.max(0,peak-baseline),eventLoopMaxMs:Number((lag.max/1e6).toFixed(2)),verified:true};
  }finally{clearInterval(sampling);lag.disable();await handle?.close();await fixture.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runStreamingArtifactExample(),null,2));
