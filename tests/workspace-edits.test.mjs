import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';
import {parseWorkspaceEdit, parseWorkspaceEditPreview, previewWorkspaceEdit, applyWorkspaceEdit, recoverWorkspaceEdit, createWorkspaceCompensation} from '../src/workspace-edits.mjs';
import {createNodeWorkspaceEditJournal} from '../src/workspace-edits-node.mjs';
import {editHash, textDifference} from '../src/workspace-edit-contracts.mjs';
import {parseLanguageRequest, createLanguageResult, createLanguageRegistry} from '../src/index.mjs';
import {deferred} from './fixtures.mjs';

const token = 'workspace-edit-test-operator-token-0123456789';
const edit = (start, end, text, line = 0) => ({range: {start: {line, character: start}, end: {line, character: end}}, text});
const proposal = changes => ({formatVersion: 1, id: randomUUID(), title: 'Reviewed change', changes});
const reviewed = preview => ({planId: preview.planId, digest: preview.digest});
const memoryJournal = () => {
  const data = new Map();
  return {async begin(record) {if (data.has(record.preview.planId)) throw Object.assign(new Error(), {code: 'conflict'}); data.set(record.preview.planId, record);}, async write(record) {data.set(record.preview.planId, record);}, async read(id) {return data.get(id);}};
};
async function fixture(t, options = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dds-edits-test-'))), root = path.join(parent, 'workspace'), workspaceId = randomUUID();
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'first.txt'), 'alpha 😀\r\nnext'); await fs.writeFile(path.join(root, 'second.txt'), 'alpha second');
  const server = await createWorkspaceServer({root, workspaceId, token, notice: {id: 'edits-test', version: '1', text: 'Disposable test'}, ...options});
  const client = createWorkspaceClient({url: server.url, token}); await client.connect();
  const journals = [];
  const openJournal = async (overrides = {}) => {const journal = await createNodeWorkspaceEditJournal({directory: path.join(parent, 'journal'), workspaceRoot: root, workspaceId, ...overrides}); journals.push(journal); return journal;};
  t.after(async () => {for (const journal of journals) await journal.close(); client.dispose(); await server.close(); assert.equal(path.dirname(parent), await fs.realpath(os.tmpdir())); assert.ok(path.basename(parent).startsWith('dds-edits-test-')); await fs.rm(parent, {recursive: true});});
  return {parent, root, workspaceId, client, server, openJournal};
}
async function editFirst(client, text = 'beta') {
  const file = await client.readFile('first.txt');
  return proposal([{kind: 'edit', path: file.path, baseRevision: file.revision, edits: [edit(0, 5, text)]}]);
}

test('proposal and preview reject unsafe, duplicate, dependent and invalid UTF-16 edits', async t => {
  const {client} = await fixture(t);
  for (const target of ['../outside', '.env', '.git/config', 'x/secret.key', 'C:/outside', 'link\\file']) assert.throws(() => parseWorkspaceEdit(proposal([{kind: 'create', path: target, content: ''}])), {code: 'unsafe_path'});
  for (const paths of [['a', 'A'], ['a', 'a-b', 'a/b']]) assert.throws(() => parseWorkspaceEdit(proposal(paths.map(path => ({kind: 'create', path, content: ''})))), {code: 'invalid_request'});
  const p = await editFirst(client);
  for (const edits of [[edit(0, 5, 'x'), edit(4, 6, 'y')], [edit(7, 7, '')], [edit(0, 5, 'alpha')]]) {
    const changed = {...p, changes: [{...p.changes[0], edits}]};
    if (edits[0].text === 'alpha') assert.equal((await previewWorkspaceEdit(client, changed)).conflicts[0].code, 'no_change');
    else await assert.rejects(previewWorkspaceEdit(client, changed), {code: 'invalid_request'});
  }
  const preview = await previewWorkspaceEdit(client, p), changed = structuredClone(preview); changed.steps[0].after[0].state.content = 'wrong';
  assert.throws(() => parseWorkspaceEditPreview(changed), {code: 'conflict'});
  assert.equal(preview.steps[0].after[0].state.content, 'beta 😀\r\nnext');
  const diff = textDifference('a😀\r\nx', 'a😁\r\ny');
  assert.equal('a😀\r\nx'.slice(0, diff.start) + diff.insertText + 'a😀\r\nx'.slice(diff.start + diff.deleteCount), 'a😁\r\ny');
});

test('real HTTP apply uses reviewed digests, persistent intent, CAS and independently reviewed compensation', async t => {
  const {client, openJournal} = await fixture(t), journal = await openJournal();
  const first = await client.readFile('first.txt'), second = await client.readFile('second.txt');
  const p = proposal([
    {kind: 'edit', path: 'first.txt', baseRevision: first.revision, edits: [edit(0, 5, 'beta')]},
    {kind: 'move', path: 'second.txt', newPath: 'moved.txt', baseRevision: second.revision},
    {kind: 'create', path: 'created.txt', content: 'created'},
  ]);
  const preview = await previewWorkspaceEdit(client, p);
  assert.deepEqual(preview.requiredCapabilities, ['write', 'manage']);
  await assert.rejects(applyWorkspaceEdit(client, preview, {journal, reviewed: {...reviewed(preview), digest: '0'.repeat(64)}, authorize: () => true}), {code: 'conflict'});
  const approvals = [];
  const applied = await applyWorkspaceEdit(client, preview, {journal, reviewed: reviewed(preview), authorize: info => {approvals.push(info.phase); return true;}});
  assert.equal(applied.status, 'completed'); assert.equal(applied.executionStopped, false);
  assert.equal((await journal.read(p.id)).phase, 'completed'); assert.ok(approvals.includes('apply'));
  assert.equal((await client.readFile('first.txt')).content, 'beta 😀\r\nnext');
  await assert.rejects(client.readFile('second.txt'), {code: 'not_found'});
  const recovery = await recoverWorkspaceEdit(client, journal, p.id); assert.equal(recovery.status, 'completed');
  const rollback = createWorkspaceCompensation(preview, recovery, {id: randomUUID()});
  assert.deepEqual(rollback.changes.map(change => change.kind), ['delete', 'move', 'edit']);
  const restorePreview = await previewWorkspaceEdit(client, rollback);
  assert.equal((await applyWorkspaceEdit(client, restorePreview, {journal, reviewed: reviewed(restorePreview), authorize: () => true})).status, 'completed');
  assert.equal((await client.readFile('first.txt')).content, first.content); assert.equal((await client.readFile('second.txt')).content, second.content);
  assert.equal((await recoverWorkspaceEdit(client, journal, p.id)).status, 'uncertain');
  assert.ok((await journal.list()).every(item => item.available));
  await journal.close();
  const reopened = await openJournal(); assert.equal((await reopened.read(p.id)).phase, 'completed');
  await assert.rejects(reopened.begin(await reopened.read(p.id)), {code: 'invalid_request'});
});

test('preflight checks every file and move destination before changing any file', async t => {
  const {client, root} = await fixture(t), first = await client.readFile('first.txt'), second = await client.readFile('second.txt');
  const p = proposal([{kind: 'edit', path: first.path, baseRevision: first.revision, edits: [edit(0, 5, 'beta')]}, {kind: 'move', path: second.path, newPath: 'moved.txt', baseRevision: second.revision}]);
  const preview = await previewWorkspaceEdit(client, p), journal = memoryJournal();
  await fs.writeFile(path.join(root, 'moved.txt'), 'someone else');
  await assert.rejects(applyWorkspaceEdit(client, preview, {journal, reviewed: reviewed(preview), authorize: () => true}), {code: 'conflict'});
  assert.equal((await client.readFile(first.path)).content, first.content);
  const blocked = await previewWorkspaceEdit(client, p); assert.equal(blocked.ready, false); assert.equal(blocked.conflicts[0].code, 'destination_exists');
  await fs.unlink(path.join(root, 'moved.txt')); await fs.writeFile(path.join(root, second.path), 'external change');
  await assert.rejects(applyWorkspaceEdit(client, preview, {journal, reviewed: reviewed(preview), authorize: () => true}), {code: 'conflict'});
  assert.equal((await client.readFile(first.path)).content, first.content);
});

test('revocation, journal failure and a concurrent external edit stop a partially applied plan', async t => {
  const {client, root} = await fixture(t), first = await client.readFile('first.txt'), second = await client.readFile('second.txt');
  const p = proposal([{kind: 'edit', path: first.path, baseRevision: first.revision, edits: [edit(0, 5, 'beta')]}, {kind: 'edit', path: second.path, baseRevision: second.revision, edits: [edit(0, 5, 'beta')]}]);
  const preview = await previewWorkspaceEdit(client, p), journal = memoryJournal();
  const receipt = await applyWorkspaceEdit(client, preview, {journal, reviewed: reviewed(preview), authorize: ({index}) => index !== 1});
  assert.equal(receipt.status, 'partial'); assert.equal(receipt.errorCode, 'permission_denied');
  assert.equal((await client.readFile(second.path)).content, second.content);
  const next = await previewWorkspaceEdit(client, await editFirst(client, 'gamma'));
  const broken = memoryJournal(); broken.write = async () => {throw new Error('journal disk failure');};
  const failed = await applyWorkspaceEdit(client, next, {journal: broken, reviewed: reviewed(next), authorize: () => true});
  assert.equal(failed.status, 'not-applied'); assert.equal(failed.journalError, 'provider_failed');
  assert.equal((await client.readFile(first.path)).content, 'beta 😀\r\nnext');
  const concurrent = await previewWorkspaceEdit(client, await editFirst(client, 'gamma'));
  const changed = await applyWorkspaceEdit(client, concurrent, {journal: memoryJournal(), reviewed: reviewed(concurrent), authorize: async ({phase}) => {if (phase === 'apply') await fs.writeFile(path.join(root, first.path), 'other editor'); return true;}});
  assert.equal(changed.executionStopped, true); assert.equal(changed.steps[0].state, 'conflicted');
  assert.equal((await client.readFile(first.path)).content, 'other editor');
});

test('a lost response is read back without replay and a failed receipt write remains recoverable', async t => {
  const {client} = await fixture(t), journal = memoryJournal(), preview = await previewWorkspaceEdit(client, await editFirst(client));
  let calls = 0;
  const lost = {...client, writeFile: async (...args) => {calls++; await client.writeFile(...args); throw Object.assign(new Error(), {code: 'transport_failed'});}};
  const receipt = await applyWorkspaceEdit(lost, preview, {journal, reviewed: reviewed(preview), authorize: () => true});
  assert.equal(receipt.status, 'completed'); assert.equal(receipt.executionStopped, true); assert.equal(calls, 1);
  assert.equal((await recoverWorkspaceEdit(client, journal, preview.planId)).status, 'completed');
  const second = await previewWorkspaceEdit(client, await editFirst(client, 'delta'));
  const broken = memoryJournal(), save = broken.write;
  broken.write = async record => {if (record.steps[0].state === 'applied') throw new Error('lost receipt'); await save(record);};
  const applied = await applyWorkspaceEdit(client, second, {journal: broken, reviewed: reviewed(second), authorize: () => true});
  assert.equal(applied.status, 'completed'); assert.equal(applied.journalError, 'provider_failed');
  assert.equal((await broken.read(second.planId)).steps[0].state, 'intent');
  assert.equal((await recoverWorkspaceEdit(client, broken, second.planId)).status, 'completed');
});

test('read-only hosts, changed generation and cancellation cannot apply an old preview', async t => {
  const {client} = await fixture(t, {writable: false}), preview = await previewWorkspaceEdit(client, await editFirst(client));
  const opts = {journal: memoryJournal(), reviewed: reviewed(preview), authorize: () => true};
  await assert.rejects(applyWorkspaceEdit(client, preview, opts), {code: 'permission_denied'});
  const changed = {...client, binding: {...client.binding, workspace: {...client.binding.workspace, generation: randomUUID()}}};
  await assert.rejects(applyWorkspaceEdit(changed, preview, opts), {code: 'generation_mismatch'});
  await assert.rejects(applyWorkspaceEdit(client, preview, {...opts, signal: AbortSignal.abort()}), {code: 'cancelled'});
});

test('Node journal refuses workspace nesting, wrong identities, live writers and filesystem links', async t => {
  const {parent, root, workspaceId, client, openJournal} = await fixture(t);
  await assert.rejects(openJournal({directory: path.join(root, 'journal')}), {code: 'unsafe_path'});
  const journal = await openJournal(); await assert.rejects(openJournal({recoverStaleLock: true}), {code: 'conflict'});
  const preview = await previewWorkspaceEdit(client, await editFirst(client));
  await applyWorkspaceEdit(client, preview, {journal, reviewed: reviewed(preview), authorize: () => true});
  const recordFile = path.join(parent, 'journal', preview.planId, 'record.json');
  await fs.link(recordFile, path.join(parent, 'alias.json'));
  await assert.rejects(journal.read(preview.planId), {code: 'unsafe_path'}); await fs.unlink(path.join(parent, 'alias.json'));
  await journal.close(); await assert.rejects(openJournal({workspaceId: randomUUID()}), {code: 'workspace_mismatch'});
  const external = path.join(parent, 'external'); await fs.mkdir(external); await fs.writeFile(path.join(external, 'foreign.txt'), 'preserve');
  await fs.symlink(external, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(previewWorkspaceEdit(client, proposal([{kind: 'delete', path: 'linked/foreign.txt', baseRevision: editHash('preserve')}])), {code: 'unsafe_path'});
  assert.equal(await fs.readFile(path.join(external, 'foreign.txt'), 'utf8'), 'preserve');
  assert.equal(typeof workspaceId, 'string');
});

test('rename proposals and preparation are language data with validated request positions', async () => {
  const snapshot = {uri: 'memory:///demo', languageId: 'teaching', modelVersion: 1, workspaceRevision: 'r1', text: 'alpha 😀'};
  const req = {protocolVersion: 1, requestId: 'rename', scope: {projectId: 'p', sessionId: 's'}, snapshot, position: {line: 0, character: 2}, kind: 'rename', newName: 'beta'};
  assert.equal(parseLanguageRequest(req).newName, 'beta');
  for (const newName of ['', '\ud800', 'bad\nname', 'x'.repeat(257)]) assert.throws(() => parseLanguageRequest({...req, newName}), {code: 'invalid_contract'});
  const {newName: _, ...prepare} = {...req, kind: 'prepare-rename'};
  assert.throws(() => createLanguageResult(prepare, {placeholder: 'other', range: edit(3, 5, '').range}), {code: 'invalid_contract'});
  assert.throws(() => createLanguageResult(prepare, {placeholder: 'split', range: edit(6, 7, '').range}), {code: 'invalid_contract'});
  assert.throws(() => createLanguageResult(req, proposal([{kind: 'delete', path: '.env', baseRevision: 'a'.repeat(64)}])), {code: 'invalid_contract'});
  const registry = createLanguageRegistry('rename'), finished = deferred(), started = deferred();
  registry.register('slow', {languages: ['teaching']}, {provide: async request => {started.resolve(); await finished.promise; return createLanguageResult(request, null);}});
  const pending = registry.request(req), rejected = assert.rejects(pending, {code: 'stale_snapshot'});
  await started.promise; registry.invalidate(); await rejected; finished.resolve(); registry.dispose();
});

test('a stalled approval can be cancelled; corrupted journals and simultaneous apply are rejected before writes', async t => {
  const {client} = await fixture(t), preview = await previewWorkspaceEdit(client, await editFirst(client)), journal = memoryJournal();
  const started = deferred(), never = deferred(), controller = new AbortController();
  const operation = applyWorkspaceEdit(client, preview, {journal, reviewed: reviewed(preview), signal: controller.signal, authorize: () => {started.resolve(); return never.promise;}});
  const rejected = assert.rejects(operation, {code: 'cancelled'}); await started.promise;
  await assert.rejects(applyWorkspaceEdit(client, preview, {journal, reviewed: reviewed(preview), authorize: () => true}), {code: 'conflict'});
  await assert.rejects(recoverWorkspaceEdit(client, journal, preview.planId), {code: 'conflict'});
  controller.abort(); await rejected; never.resolve(true);
  const corrupted = memoryJournal(), originalRead = corrupted.read;
  corrupted.read = async id => ({...await originalRead(id), revision: 999});
  await assert.rejects(applyWorkspaceEdit(client, preview, {journal: corrupted, reviewed: reviewed(preview), authorize: () => true}), {code: 'conflict'});
  assert.equal((await client.readFile('first.txt')).content, 'alpha 😀\r\nnext');
});

test('recovery after a host restart uses current reads while the old preview cannot be applied', async t => {
  const {client, server, root, workspaceId, openJournal} = await fixture(t), journal = await openJournal();
  const preview = await previewWorkspaceEdit(client, await editFirst(client));
  assert.equal((await applyWorkspaceEdit(client, preview, {journal, reviewed: reviewed(preview), authorize: () => true})).status, 'completed');
  await server.close();
  const replacement = await createWorkspaceServer({root, workspaceId, token, notice: {id: 'restart', version: '1', text: 'Fresh connection'}}), current = createWorkspaceClient({url: replacement.url, token});
  try {
    await current.connect(); assert.notEqual(current.binding.workspace.generation, preview.workspace.generation);
    await assert.rejects(applyWorkspaceEdit(current, preview, {journal, reviewed: reviewed(preview), authorize: () => true}), {code: 'generation_mismatch'});
    const recovered = await recoverWorkspaceEdit(current, journal, preview.planId);
    assert.equal(recovered.status, 'completed'); assert.equal(recovered.currentGeneration, current.binding.workspace.generation);
  } finally {current.dispose(); await replacement.close();}
});
