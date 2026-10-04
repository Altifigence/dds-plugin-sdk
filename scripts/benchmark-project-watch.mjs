import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {createNodeWorkspace} from '../src/workspace-node.mjs';
import {createNodeProjectWatcher} from '../src/project-watch-node.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-watch-benchmark-'));
let workspace,watcher,iterator;
try{
  const files=128,fileBytes=16_384;
  for(let n=0;n<files;n++)await fs.writeFile(path.join(root,String(n).padStart(3,'0')+'.txt'),Buffer.alloc(fileBytes,65+n%20));
  workspace=await createNodeWorkspace({root});watcher=await createNodeProjectWatcher({workspace,roots:[''],fileSystem:'local'});
  const memoryBefore=process.memoryUsage().rss,start=performance.now();
  iterator=watcher.watch({root:'',intervalMs:250,debounceMs:20},{signal:AbortSignal.timeout(30_000)});
  const initial=(await iterator.next()).value,initialMs=performance.now()-start;assert.equal(initial.snapshot.entries.length,files);assert.equal(initial.snapshot.complete,true);
  const content=Buffer.alloc(fileBytes,42),expected=createHash('sha256').update(content).digest('hex');const changedAt=performance.now();
  await fs.writeFile(path.join(root,'.dds-write-benchmark'),content);await fs.rename(path.join(root,'.dds-write-benchmark'),path.join(root,'000.txt'));
  for await(const update of iterator)if(update.snapshot.entries.find(x=>x.path==='000.txt')?.revision===expected)break;
  const latencyMs=performance.now()-changedAt,memoryDeltaBytes=process.memoryUsage().rss-memoryBefore,metrics=watcher.inspect();
  assert.equal(metrics.nativeHandles,0);assert.equal(metrics.observers,0);
  console.log(JSON.stringify({node:process.version,platform:process.platform,filesystemType:watcher.capabilities.filesystemType,files,fileBytes,initialMs:Number(initialMs.toFixed(2)),changeLatencyMs:Number(latencyMs.toFixed(2)),rssDeltaBytes:memoryDeltaBytes,scanBytes:metrics.bytesRead,scans:metrics.scans,maxScanMs:metrics.maxScanMs,complete:true,nativeHandlesAfterClose:metrics.nativeHandles}));
}finally{
  await iterator?.return();watcher?.dispose();workspace?.dispose();
  assert.ok(root.startsWith(path.join(os.tmpdir(),'dds-project-watch-benchmark-')));await fs.rm(root,{recursive:true});
}
