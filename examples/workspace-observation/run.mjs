import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient, createWorkspaceProject} from '@altifigence/dds-plugin-sdk/workspace-client';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dds-observation-example-')));
const token = randomBytes(32).toString('hex');
const artifactSha256 = 'a'.repeat(64); // Local fixture identity; pin a verified release in real use.
let finish, executions = 0;
const completed = new Promise(resolve => {finish = resolve;});
const plugin = definePlugin({manifestVersion:2,id:'observation-example',name:'Observation Example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./run.mjs',runtime:'workspace',capabilities:['commands'],permissions:[],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}}, context => context.registerCommand({id:'analyze',title:'Analyze'}, async (_, {job}) => {
  executions++; job.log('info', 'Analysis started');
  await completed; job.reportProgress({completed:1,total:1});
  return {modules:1};
}));
let server, client, project, files, watching;
try {
  await writeFile(path.join(root,'design.sv'),'module original; endmodule\n');
  server = await createWorkspaceServer({root,token,workspaceId:randomUUID(),notice:{id:'example',version:'1',text:'Local disposable observation example.'},jobs:true,plugins:[{plugin,artifactSha256}]});
  client = createWorkspaceClient({url:server.url,token}); await client.connect();
  project = createWorkspaceProject(client);
  const edit = await project.openFile('design.sv'), original = edit.snapshot;
  assert.equal((await client.getFileCapabilities()).revision,true);
  assert.deepEqual(await client.getFileRevision('design.sv'),{path:'design.sv',revision:original.revision});
  assert.deepEqual(await client.readFileIfChanged('design.sv',original.revision),{path:'design.sv',revision:original.revision,notModified:true});
  files = project.watchFiles(['design.sv'],{intervalMs:250});
  assert.equal((await files.next()).value.kind,'initial');
  await writeFile(path.join(root,'design.sv'),'module external; endmodule\n');
  assert.equal((await files.next()).value.kind,'changed');
  const changed=await client.readFileIfChanged('design.sv',original.revision);
  assert.equal(changed.notModified,false);assert.equal(changed.content,'module external; endmodule\n');
  assert.equal(edit.snapshot,original);
  await assert.rejects(edit.save('my unsaved draft'),{code:'conflict'});
  await files.return();

  assert.equal((await client.getJobCapabilities()).enabled,true);
  const job = await client.startCommandJob(plugin.manifest.id,'analyze',{},artifactSha256,{jobId:randomUUID()});
  watching = client.watchJob(job.jobId,{intervalMs:250});
  const first = (await watching.next()).value;
  assert.ok(first.events.some(event=>event.kind==='log'));
  await watching.return();
  assert.equal((await client.getJob(job.jobId)).state,'running');
  client.disconnect();
  const reconnected = await client.connect(); // Reconnection is explicit in this operator-owned fixture.
  assert.equal(reconnected.workspace.id,job.scope.projectId);
  assert.equal(reconnected.workspace.generation,job.scope.sessionId);
  finish();
  const result = await client.waitForJob(job.jobId,{after:first.nextCursor,intervalMs:250});
  assert.equal(result.state,'succeeded'); assert.equal(result.result.modules,1); assert.equal(executions,1);
  console.log('Workspace observation: file changes, retained draft and resumed job verified');
} finally {
  finish(); await files?.return(); await watching?.return(); project?.dispose(); client?.dispose(); await server?.close();
  assert.equal(path.dirname(root),await realpath(tmpdir()));
  assert.ok(path.basename(root).startsWith('dds-observation-example-'));
  await rm(root,{recursive:true});
}
