import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID, randomBytes} from 'node:crypto';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';

const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-file-bandwidth-')));
const fileBytes=200000, samples=20, token=randomBytes(32).toString('hex');
let server,client,measurement;
try {
  await fs.writeFile(path.join(root,'sample.txt'),'x'.repeat(fileBytes));
  server=await createWorkspaceServer({root,token,workspaceId:randomUUID(),writable:false,notice:{id:'benchmark',version:'1',text:'Disposable bandwidth benchmark'}});
  client=createWorkspaceClient({url:server.url,token,fetch:async(url,init)=>{
    if(measurement){measurement.requests++;measurement.requestBytes+=Buffer.byteLength(init.body);}
    const response=await fetch(url,init);
    if(measurement)measurement.responseBytes+=Buffer.byteLength(await response.clone().text());
    return response;
  }});
  await client.connect();
  const rows=[];
  for(const mode of ['fullRead','revision','conditionalUnchanged']) {
    // Reset discovery for each optimized mode; its response is included.
    await client.connect();
    const known=(await client.readFile('sample.txt')).revision;
    measurement={mode,requests:0,requestBytes:0,responseBytes:0};
    const started=performance.now();
    for(let i=0;i<samples;i++){
      if(mode==='fullRead')await client.readFile('sample.txt');
      else if(mode==='revision')await client.getFileRevision('sample.txt');
      else assert.equal((await client.readFileIfChanged('sample.txt',known)).notModified,true);
    }
    measurement.elapsedMs=Number((performance.now()-started).toFixed(2));
    rows.push(measurement);measurement=undefined;
  }
  const baseline=rows[0].responseBytes;
  for(const row of rows)row.responseReductionPercent=Number((100*(1-row.responseBytes/baseline)).toFixed(3));
  assert.ok(rows[1].responseBytes<baseline/100 && rows[2].responseBytes<baseline/100);
  console.log(JSON.stringify({node:process.version,fileBytes,samples,measurement:'UTF-8 JSON HTTP bodies; headers and TLS excluded; initial hello/content baseline excluded; discovery included',serverReads:'Each operation still performs one guarded full file read and SHA-256',rows},null,2));
} finally {
  client?.dispose();await server?.close();
  assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-file-bandwidth-'));
  await fs.rm(root,{recursive:true});
}
