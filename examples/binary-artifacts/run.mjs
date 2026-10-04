import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {BINARY_ARTIFACT_LIMITS} from '@altifigence/dds-plugin-sdk/artifacts';
import {createWorkspaceServer, downloadJobBinaryArtifact} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';

/** Real files and HTTP; all generated files are owned by this disposable example. */
export async function runBinaryArtifactExample({fileBytes = 2_097_169} = {}) {
  assert.ok(Number.isSafeInteger(fileBytes) && fileBytes > 262_144 && fileBytes <= 33_554_432);
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dds-binary-example-')));
  const root = path.join(directory, 'workspace'), output = path.join(directory, 'downloads');
  let server, client;
  try {
    await fs.mkdir(root); await fs.mkdir(output);
    const block = Buffer.from(Array.from({length:BINARY_ARTIFACT_LIMITS.chunkBytes}, (_, index) => index & 255));
    const sourceHash = createHash('sha256'), source = await fs.open(path.join(root, 'trace.bin'), 'wx');
    try {
      for (let offset = 0; offset < fileBytes; offset += block.length) {
        const bytes = block.subarray(0, Math.min(block.length, fileBytes - offset));
        await source.writeFile(bytes); sourceHash.update(bytes);
      }
    } finally {await source.close();}
    const expected = sourceHash.digest('hex'), token = randomBytes(32).toString('hex');
    const manifest = {manifestVersion:2,id:'binary-example',name:'Binary result example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
    const plugin = definePlugin(manifest, context => context.registerCommand({id:'collect',title:'Collect generated trace'}, async (_, {job}) => {
      if (!job) throw new Error('Start this command as a job');
      await job.addBinaryArtifact({id:'trace',path:'trace.bin',label:'Generated binary trace'}); return {artifact:'trace'};
    }));
    // Source example identity only; deployed hosts must pin the reviewed plugin archive.
    const pluginPin = createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
    server = await createWorkspaceServer({root,workspaceId:randomUUID(),token,jobs:true,binaryArtifacts:true,writable:false,grants:['workspace.read'],plugins:[{plugin,artifactSha256:pluginPin}],notice:{id:'binary-example',version:'1',text:'Temporary binary result example. No external tool or network service.'}});
    const ranges = [];
    client = createWorkspaceClient({url:server.url,token,fetch:async (url,options) => {
      const request = JSON.parse(options.body), response = await fetch(url,options);
      if (request.method === 'artifacts.read') {
        const reply = await response.clone().json();
        if (reply.ok) ranges.push({offset:request.params.offset,bytes:reply.result.nextOffset-reply.result.offset,responseBytes:Buffer.byteLength(JSON.stringify(reply))});
      }
      return response;
    }});
    await client.connect(); assert.equal((await client.getBinaryArtifactCapabilities()).enabled,true);
    const job = await client.startCommandJob(manifest.id,'collect',{},pluginPin,{jobId:randomUUID()});
    const complete = await client.waitForJob(job.jobId,{intervalMs:250}); assert.equal(complete.state,'succeeded');
    const reference = await client.getJobBinaryArtifact(job.jobId,'trace'); assert.equal(reference.artifact.revision,expected);
    const destination = path.join(output,'trace.bin'), controller = new AbortController(), started = performance.now();
    await assert.rejects(downloadJobBinaryArtifact(client,reference,{destination,signal:controller.signal,onProgress:update=>{if(update.receivedBytes>=BINARY_ARTIFACT_LIMITS.chunkBytes)controller.abort();}}),{code:'cancelled'});
    client.disconnect(); await client.connect(); const resumedAt = ranges.length;
    const receipt = await downloadJobBinaryArtifact(client,reference,{destination,resume:true});
    assert.equal(receipt.verified,true); assert.equal(receipt.revision,expected); assert.equal(receipt.byteLength,fileBytes);
    assert.equal(ranges[resumedAt].offset,BINARY_ARTIFACT_LIMITS.chunkBytes);
    assert.equal(ranges.reduce((sum,range)=>sum+range.bytes,0),fileBytes);
    assert.equal((await fs.stat(destination)).size,fileBytes);
    return {node:process.version,fileBytes,chunkBytes:BINARY_ARTIFACT_LIMITS.chunkBytes,requests:ranges.length,maxDecodedResponseBytes:Math.max(...ranges.map(range=>range.bytes)),jsonResponseBytes:ranges.reduce((sum,range)=>sum+range.responseBytes,0),resumedBytes:receipt.resumedBytes,downloadedBytesAfterResume:ranges.slice(resumedAt).reduce((sum,range)=>sum+range.bytes,0),sha256:expected,verified:receipt.verified,elapsedMs:Number((performance.now()-started).toFixed(2))};
  } finally {
    client?.dispose(); await server?.close();
    assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir())); assert.ok(path.basename(directory).startsWith('dds-binary-example-'));
    await fs.rm(directory,{recursive:true});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await runBinaryArtifactExample(),null,2));
