import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {previewWorkspaceEdit, applyWorkspaceEdit} from '@altifigence/dds-plugin-sdk/workspace-edits';
import {createNodeWorkspaceEditJournal} from '@altifigence/dds-plugin-sdk/workspace-edits-node';
import plugin from './plugin.mjs';

const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dds-format-example-'))), root = path.join(parent, 'workspace'), workspaceId = randomUUID();
const token = 'disposable-formatting-example-token-0123456789'; let server, client, host, journal, version = 0;
const formatOptions = {tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true};
try {
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'main.dds'), 'TODO  \r\nTODO 😀  \r\n');
  server = await createWorkspaceServer({root, workspaceId, token, notice: {id: 'format-example', version: '1', text: 'Disposable formatting example'}});
  client = createWorkspaceClient({url: server.url, token}); await client.connect();
  journal = await createNodeWorkspaceEditJournal({directory: path.join(parent, 'journal'), workspaceRoot: root, workspaceId});
  host = createPluginHost({grants: ['document.read', 'diagnostics.publish', 'language.provide']}); await host.activate(plugin);
  async function refresh() {
    const file = await client.readFile('main.dds');
    host.setDocument({uri: 'memory:///main.dds', languageId: 'teaching', modelVersion: ++version, workspaceRevision: file.revision, text: file.content});
    await host.requestDiagnostics(); return file;
  }
  const original = await refresh();
  const rangeResult = await host.requestLanguage('format-range', {path: 'main.dds', range: {start: {line: 0, character: 0}, end: {line: 0, character: 6}}, formatOptions});
  assert.equal(host.prepareFormatting(rangeResult).changes[0].edits.length, 1);
  const formatted = await host.requestLanguage('format-document', {path: 'main.dds', formatOptions});
  const preview = await previewWorkspaceEdit(client, host.prepareFormatting(formatted));
  assert.equal((await client.readFile('main.dds')).content, original.content);
  const approve = preview => ({journal, reviewed: {planId: preview.planId, digest: preview.digest}, authorize: () => true});
  assert.equal((await applyWorkspaceEdit(client, preview, approve(preview))).status, 'completed');
  assert.equal((await refresh()).content, 'TODO\r\nTODO 😀\r\n');
  assert.equal((await host.requestLanguage('format-document', {path: 'main.dds', formatOptions})).data, null);
  const actionInput = {path: 'main.dds', range: {start: {line: 0, character: 0}, end: {line: 2, character: 0}}, context: {triggerKind: 'invoked', only: ['quickfix']}};
  const listed = await host.requestLanguage('code-actions', actionInput); assert.equal(listed.data.length, 2);
  const selected = await host.resolveCodeAction(listed.data[0].resolveToken);
  const stalePreview = await previewWorkspaceEdit(client, host.prepareCodeAction(selected));
  await fs.appendFile(path.join(root, 'main.dds'), '// keep outside edit\r\n');
  await assert.rejects(applyWorkspaceEdit(client, stalePreview, approve(stalePreview)), {code: 'conflict'});
  await refresh(); assert.throws(() => host.prepareCodeAction(selected), {code: 'stale_snapshot'});
  const current = await host.requestLanguage('code-actions', actionInput);
  const resolved = await host.resolveCodeAction(current.data[0].resolveToken);
  const currentPreview = await previewWorkspaceEdit(client, host.prepareCodeAction(resolved));
  assert.equal((await applyWorkspaceEdit(client, currentPreview, approve(currentPreview))).status, 'completed');
  assert.equal((await client.readFile('main.dds')).content, 'DONE\r\nTODO 😀\r\n// keep outside edit\r\n');
  console.log('range formatting, CRLF preservation, diagnostic quick-fix, conflict and selected approval verified');
} finally {
  host?.dispose(); client?.dispose(); await journal?.close(); await server?.close();
  assert.equal(path.dirname(parent), await fs.realpath(os.tmpdir())); assert.ok(path.basename(parent).startsWith('dds-format-example-')); await fs.rm(parent, {recursive: true});
}
