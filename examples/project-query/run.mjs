import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createNodeWorkspace} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createNodeProjectWatcher} from '@altifigence/dds-plugin-sdk/project-watch-node';
import {createNodeProjectQueries} from '@altifigence/dds-plugin-sdk/project-query-node';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-query-example-'));
let workspace,watcher,queries,observer;
try{
  await fs.mkdir(path.join(root,'rtl'));
  await fs.writeFile(path.join(root,'rtl','a.sv'),'module a; endmodule\n');
  await fs.writeFile(path.join(root,'rtl','b.sv'),'module b; endmodule\n');
  workspace=await createNodeWorkspace({root});
  watcher=await createNodeProjectWatcher({workspace,roots:['rtl'],fileSystem:'local'});
  queries=createNodeProjectQueries({watcher});
  const tree=await queries.listTree({root:'rtl'});assert.equal(tree.total,2);
  const files=await queries.searchFiles({root:'rtl',query:'**/*.SV',mode:'glob',caseSensitive:false});assert.equal(files.total,2);
  const options={root:'rtl',query:'module ',pageSize:1};
  const first=await queries.searchText(options);assert.ok(first.nextCursor);assert.equal(first.items[0].match.range.start.character,0);
  observer=watcher.watch({root:'rtl',include:['**/*.sv']},{signal:AbortSignal.timeout(30_000)});
  const initial=(await observer.next()).value;assert.equal(initial.snapshot.complete,true);
  await fs.writeFile(path.join(root,'rtl','b.sv'),'// changed externally\n');
  const second=await queries.searchText({...options,cursor:first.nextCursor});
  assert.equal(second.items[0].entry.path,'rtl/b.sv');assert.equal(second.items[0].state,'changed');assert.equal(second.stale,true);
  // A captured snippet is historical. Keep editor drafts and re-read before editing.
  queries.releaseCursor(first.nextCursor);
  await observer.return();queries.dispose();
  assert.equal(watcher.inspect().nativeHandles,0);assert.equal(queries.inspect().views,0);
  console.log('Project queries: scoped tree, glob, text ranges, stale page and shared observation verified');
}finally{
  await observer?.return();queries?.dispose();watcher?.dispose();workspace?.dispose();
  assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-project-query-example-'));await fs.rm(root,{recursive:true});
}
