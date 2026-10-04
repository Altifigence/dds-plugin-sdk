import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient,createWorkspaceProject} from '@altifigence/dds-plugin-sdk/workspace-client';

const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-tools-example-')));
const token='disposable-project-example-token-0123456789';let server,client,project,observer;
try{
  await fs.mkdir(path.join(root,'rtl'));
  server=await createWorkspaceServer({root,workspaceId:randomUUID(),token,notice:{id:'example',version:'1',text:'Disposable project example'},projects:{roots:['rtl'],fileSystem:'local'}});
  client=createWorkspaceClient({url:server.url,token});await client.connect();project=createWorkspaceProject(client);
  assert.equal((await project.getProjectCapabilities()).enabled,true);
  const edit=await project.createFile('rtl/counter.sv','module counter; endmodule\n'),original=edit.snapshot,draft=original.content+'// keep my draft\n';
  const query={root:'rtl',query:'module '},page=await project.searchText(query);assert.equal(page.total,1);
  observer=project.watchProject({root:'rtl',intervalMs:250,debounceMs:20},{timeoutMs:30000});await observer.next();
  await fs.writeFile(path.join(root,'rtl','counter.sv'),'module externally_changed; endmodule\n');
  let update;for await(const event of observer)if(event.snapshot.entries[0]?.revision!==original.revision){update=event;break;}
  assert.notEqual(update.snapshot.revision,page.snapshotRevision);
  // Discard old pages and repeat only the same explicitly selected query scope.
  const refreshed=await project.searchText(query);assert.equal(refreshed.items[0].entry.revision,update.snapshot.entries[0].revision);
  assert.equal(edit.snapshot,original);assert.ok(draft.includes('keep my draft'));await assert.rejects(edit.save(draft),{code:'conflict'});
  await edit.reload();assert.match(edit.snapshot.content,/externally_changed/);
  project.dispose();client.disconnect();await client.connect();project=createWorkspaceProject(client);
  observer=project.watchProject({root:'rtl'},{timeoutMs:30000});assert.equal((await observer.next()).value.cursor,1);await observer.return();
  console.log('Project tools: create, search, external update, resync query, retained draft, CAS conflict and reconnect verified');
}finally{
  await observer?.return();project?.dispose();client?.dispose();await server?.close();
  assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-project-tools-example-'));await fs.rm(root,{recursive:true});
}
