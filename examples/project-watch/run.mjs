import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createNodeWorkspace} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createNodeProjectWatcher} from '@altifigence/dds-plugin-sdk/project-watch-node';

const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-watch-example-'));
let workspace,port,iterator;
try{
  await fs.mkdir(path.join(root,'rtl'));await fs.writeFile(path.join(root,'rtl','top.sv'),'module top; endmodule\n');
  workspace=await createNodeWorkspace({root});
  port=await createNodeProjectWatcher({workspace,roots:['rtl'],fileSystem:'local'});
  iterator=port.watch({root:'rtl',include:['**/*.sv'],exclude:['generated/**'],intervalMs:250},{signal:AbortSignal.timeout(10_000)});
  const initial=(await iterator.next()).value;assert.equal(initial.snapshot.entries[0].path,'rtl/top.sv');
  const nextText='module changed; endmodule\n';
  await fs.writeFile(path.join(root,'rtl','.dds-write-example'),nextText);
  await fs.rename(path.join(root,'rtl','.dds-write-example'),path.join(root,'rtl','top.sv'));
  const expected=createHash('sha256').update(nextText).digest('hex');
  for await(const update of iterator){
    // A resync supplies a replacement bounded view. Never apply a partial delta.
    if(update.snapshot.entries.some(entry=>entry.path==='rtl/top.sv'&&entry.revision===expected))break;
  }
  assert.equal(port.inspect().nativeHandles,0);
  console.log('Project observation: explicit root, initial snapshot, atomic save and resource cleanup verified');
}finally{
  await iterator?.return();port?.dispose();workspace?.dispose();
  assert.ok(root.startsWith(path.join(os.tmpdir(),'dds-project-watch-example-')));await fs.rm(root,{recursive:true});
}
