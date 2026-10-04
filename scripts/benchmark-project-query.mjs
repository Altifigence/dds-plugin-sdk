import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createNodeWorkspace} from '../src/workspace-node.mjs';
import {createNodeProjectWatcher} from '../src/project-watch-node.mjs';
import {createNodeProjectQueries} from '../src/project-query-node.mjs';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-query-benchmark-'));
let workspace,watcher,queries;
try{
  const files=128,fileBytes=16384,content='needle\n'+'x'.repeat(fileBytes-7);
  for(let i=0;i<files;i++)await fs.writeFile(path.join(root,String(i).padStart(3,'0')+'.txt'),content);
  workspace=await createNodeWorkspace({root});watcher=await createNodeProjectWatcher({workspace,roots:[''],fileSystem:'local'});queries=createNodeProjectQueries({watcher});
  const before=process.memoryUsage().rss,start=performance.now(),options={root:'',query:'needle',pageSize:64};
  const first=await queries.searchText(options),initialMs=performance.now()-start,secondStart=performance.now();
  assert.equal(first.total,files);assert.equal(first.complete,true);assert.ok(first.nextCursor);
  const second=await queries.searchText({...options,cursor:first.nextCursor}),pageMs=performance.now()-secondStart;assert.equal(second.nextCursor,null);assert.equal(second.stale,false);
  assert.equal(watcher.inspect().bytesRead,files*fileBytes*2);queries.releaseCursor(first.nextCursor);
  console.log(JSON.stringify({node:process.version,platform:process.platform,files,fileBytes,initialMs:Number(initialMs.toFixed(2)),revalidatedPageMs:Number(pageMs.toFixed(2)),rssDeltaBytes:process.memoryUsage().rss-before,scanBytes:watcher.inspect().bytesRead,scans:watcher.inspect().scans,retainedViewsAfterRelease:queries.inspect().views}));
}finally{
  queries?.dispose();watcher?.dispose();workspace?.dispose();assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-project-query-benchmark-'));await fs.rm(root,{recursive:true});
}
