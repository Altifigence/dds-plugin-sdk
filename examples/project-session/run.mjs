import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient, createWorkspaceProject} from '@altifigence/dds-plugin-sdk/workspace-client';

const parent = await realpath(tmpdir());
const root = await realpath(await mkdtemp(join(parent, 'dds-project-example-')));
const token = randomBytes(32).toString('base64url');
let server, client, project;
try {
  await writeFile(join(root, 'design.sv'), 'module demo; endmodule\n');
  server = await createWorkspaceServer({root, token, workspaceId: crypto.randomUUID(), notice: {id: 'local-example', version: '1', text: 'This temporary workspace is owned by this example.'}});
  client = createWorkspaceClient({url: server.url, token});
  await client.connect(); project = createWorkspaceProject(client);
  const first = await project.openFile('design.sv'), second = await project.openFile('design.sv');
  await first.saveEdits([{range: {start: {line: 0, character: 7}, end: {line: 0, character: 11}}, text: 'updated'}]);
  await assert.rejects(second.save('stale content'), {code: 'conflict'});
  assert.equal(second.state, 'needs-reload');
  await second.reload(); assert.equal(second.snapshot.content, 'module updated; endmodule\n');
  await second.save(second.snapshot.content + '// Unicode: 한글 😃\n');
  await client.connect(); assert.equal(second.state, 'disposed');
  console.log('Project session: HTTP edit, conflict, reload, Unicode and reconnect verified');
} finally {
  project?.dispose(); client?.dispose(); await server?.close();
  assert.equal(dirname(await realpath(root)), parent); assert.ok(basename(root).startsWith('dds-project-example-'));
  await rm(root, {recursive: true});
}
