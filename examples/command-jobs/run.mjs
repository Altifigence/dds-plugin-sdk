import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dds-job-example-')));
const token = randomBytes(32).toString('hex');
// Fixture identity only. Real operators pin the verified plugin release digest.
const artifactSha256 = 'a'.repeat(64);
const plugin = definePlugin({manifestVersion: 2, id: 'job-example', name: 'Job Example', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './run.mjs', runtime: 'workspace', capabilities: ['commands'], permissions: ['workspace.read', 'workspace.write', 'backend.invoke'], supportedHosts: ['workspace-host'], license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'}}, context => context.registerCommand({id: 'analyze', title: 'Analyze'}, async (_, {signal, job}) => {
  if (!job) throw new Error('Use a command job');
  job.reportProgress({completed: 0, total: 2});
  const result = await job.invokeBackend('analyze', {source: 'module top; endmodule'});
  await context.workspace.writeFile('report.txt', JSON.stringify(result), {expectedRevision: null, signal});
  await job.addArtifact({id: 'report', path: 'report.txt'});
  job.reportProgress({completed: 2, total: 2});
  return result;
}));
let server, client;
try {
  server = await createWorkspaceServer({root, workspaceId: randomUUID(), token, notice: {id: 'example', version: '1', text: 'Local disposable job example.'}, plugins: [{plugin, artifactSha256}], grants: ['workspace.read', 'workspace.write', 'backend.invoke'], jobs: true, backends: {analyze: async (input, {signal, job}) => {
    signal.throwIfAborted(); job.log('info', 'Counting modules in supplied text');
    return {modules: (input.source.match(/\bmodule\b/g) ?? []).length};
  }}});
  client = createWorkspaceClient({url: server.url, token}); await client.connect();
  assert.equal((await client.getJobCapabilities()).enabled, true);
  const jobId = randomUUID();
  let result = await client.startCommandJob(plugin.manifest.id, 'analyze', {}, artifactSha256, {jobId});
  while (result.state === 'running') {await new Promise(resolve => setTimeout(resolve, 20)); result = await client.getJob(jobId);}
  assert.equal(result.state, 'succeeded'); assert.equal(result.result.modules, 1);
  assert.ok((await client.getJobEvents(jobId)).events.some(event => event.kind === 'log'));
  assert.equal(JSON.parse((await client.readJobArtifact(jobId, 'report')).content).modules, 1);
  console.log('Command job: progress, backend log and pinned result file verified');
} finally {
  client?.dispose(); await server?.close();
  assert.equal(path.dirname(root), await realpath(tmpdir()));
  assert.ok(path.basename(root).startsWith('dds-job-example-'));
  await rm(root, {recursive: true});
}
