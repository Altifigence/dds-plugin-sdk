import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {previewWorkspaceEdit, applyWorkspaceEdit, recoverWorkspaceEdit} from '@altifigence/dds-plugin-sdk/workspace-edits';
import {createNodeWorkspaceEditJournal} from '@altifigence/dds-plugin-sdk/workspace-edits-node';
import {teachingRenamePlugin} from './plugin.mjs';

const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dds-edit-example-'))), root = path.join(parent, 'workspace'), workspaceId = randomUUID();
const token = 'disposable-workspace-edit-example-0123456789', children = [], journals = [];
let server, client, language;
try {
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'first.dds'), 'alpha 😀\r\nalpha'); await fs.writeFile(path.join(root, 'second.dds'), 'alpha');
  server = await createWorkspaceServer({root, workspaceId, token, notice: {id: 'edit-example', version: '1', text: 'Disposable workspace edit example'}});
  client = createWorkspaceClient({url: server.url, token}); await client.connect();
  async function suggest(name) {
    language?.dispose(); language = createPluginHost({grants: ['document.read', 'language.provide']});
    const files = await Promise.all(['first.dds', 'second.dds'].map(file => client.readFile(file)));
    await language.activate(teachingRenamePlugin(files));
    language.setDocument({uri: 'memory:///first.dds', languageId: 'teaching', modelVersion: 1, workspaceRevision: files[0].revision, text: files[0].content});
    const position = {line: 0, character: 2}, preparation = await language.requestLanguage('prepare-rename', {position});
    assert.ok(preparation.data.placeholder);
    return (await language.requestLanguage('rename', {position, newName: name})).data;
  }
  const initial = await suggest('beta'), preview = await previewWorkspaceEdit(client, initial);
  await fs.writeFile(path.join(root, 'second.dds'), 'alpha // external edit');
  const journal = await createNodeWorkspaceEditJournal({directory: path.join(parent, 'journal'), workspaceRoot: root, workspaceId}); journals.push(journal);
  await assert.rejects(applyWorkspaceEdit(client, preview, {journal, reviewed: {planId: preview.planId, digest: preview.digest}, authorize: () => true}), {code: 'conflict'});
  assert.equal((await client.readFile('first.dds')).content, 'alpha 😀\r\nalpha');
  const refreshed = await previewWorkspaceEdit(client, await suggest('beta'));
  assert.equal((await applyWorkspaceEdit(client, refreshed, {journal, reviewed: {planId: refreshed.planId, digest: refreshed.digest}, authorize: () => true})).status, 'completed');
  assert.equal((await client.readFile('second.dds')).content, 'beta // external edit');
  await journal.close();

  // Kill a separate apply process before any file write and after its first write,
  // then inspect durable intent and current files without replaying that plan.
  for (const pauseAt of ['intent', 'applied']) {
    const recoveryPreview = await previewWorkspaceEdit(client, await suggest(pauseAt === 'intent' ? 'gamma' : 'delta'));
    const directory = path.join(parent, 'journal-' + pauseAt);
    const child = fork(fileURLToPath(new URL('./child.mjs', import.meta.url)), [], {stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true}); children.push(child);
    let stderr = ''; child.stderr.on('data', chunk => {stderr = (stderr + chunk).slice(-2048);});
    const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    const checkpoint = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Apply child checkpoint timed out')), 20_000);
      child.once('message', message => {clearTimeout(timer); resolve(message);});
      child.once('exit', () => {clearTimeout(timer); reject(Error('Apply child exited before checkpoint: ' + stderr));}); child.once('error', reject);
    });
    child.send({url: server.url, token, root, workspaceId, directory, preview: recoveryPreview, pauseAt});
    assert.deepEqual(await checkpoint, {phase: pauseAt, planId: recoveryPreview.planId}); child.kill('SIGKILL'); await exit;
    const recoveredJournal = await createNodeWorkspaceEditJournal({directory, workspaceRoot: root, workspaceId, recoverStaleLock: true}); journals.push(recoveredJournal);
    const recovered = await recoverWorkspaceEdit(client, recoveredJournal, recoveryPreview.planId);
    assert.equal(recovered.steps[0].state, pauseAt === 'intent' ? 'not-applied' : 'applied');
    assert.equal(recovered.steps[1].state, 'not-applied');
    assert.equal((await recoveredJournal.read(recoveryPreview.planId)).steps[0].state, 'intent');
    await recoveredJournal.close();
  }
  assert.equal((await client.readFile('first.dds')).content, 'delta 😀\r\ndelta');
  assert.equal((await client.readFile('second.dds')).content, 'beta // external edit');
  console.log('rename preview, external-edit conflict, reviewed CAS and killed-process recovery verified');
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit;}
  for (const journal of journals) await journal.close(); language?.dispose(); client?.dispose(); await server?.close();
  assert.equal(path.dirname(parent), await fs.realpath(os.tmpdir())); assert.ok(path.basename(parent).startsWith('dds-edit-example-')); await fs.rm(parent, {recursive: true});
}
