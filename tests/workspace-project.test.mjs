import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkspaceClient, createWorkspaceProject, applyTextEdits} from '../src/workspace-client.mjs';
import {createWorkspaceServer} from '../src/workspace-node.mjs';
import {deferred} from './fixtures.mjs';

const token = 'workspace-project-test-token-0123456789';
const workspaceId = 'a784ff42-e986-47b1-9140-b10f8ba68ca8';
const edit = (line, start, end, text) => ({range: {start: {line, character: start}, end: {line, character: end}}, text});
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dds-project-test-'));
  await writeFile(join(root, 'design.sv'), 'module design; endmodule\n');
  const server = await createWorkspaceServer({root, token, workspaceId, notice: {id: 'project-fixture', version: '1', text: 'Local project test'}, ...options});
  const client = createWorkspaceClient({url: server.url, token});
  await client.connect();
  t.after(async () => {client.dispose(); await server.close(); assert.ok(root.startsWith(join(tmpdir(), 'dds-project-test-'))); await rm(root, {recursive: true});});
  return {root, server, client};
}

test('text edits preserve CRLF and Unicode and apply against the same original snapshot', () => {
  const source = '한글 😃\r\nnext\nend';
  assert.equal(applyTextEdits(source, [edit(1, 0, 4, 'last'), edit(0, 0, 2, '한국어')]), '한국어 😃\r\nlast\nend');
  assert.equal(applyTextEdits('', [edit(0, 0, 0, 'new')]), 'new');
  assert.equal(applyTextEdits(source, []), source);
  assert.equal(applyTextEdits(source, [{range: {start: {line: 0, character: 3}, end: {line: 1, character: 2}}, text: 'x'}]), '한글 xxt\nend');
});

test('text edits reject overlap, ambiguous insertion, invalid ranges, surrogate splits and size overflow', () => {
  for (const edits of [
    [edit(0, 0, 3, 'x'), edit(0, 2, 4, 'y')],
    [edit(0, 0, 0, 'x'), edit(0, 0, 0, 'y')],
    [edit(99, 0, 1, 'x')], [edit(0, 5, 6, 'x')], [edit(0, 3, 1, 'x')],
    [edit(0, 0, 1, '\ud800')],
  ]) assert.throws(() => applyTextEdits('hello', edits), {code: 'invalid_request'});
  assert.throws(() => applyTextEdits('😃', [edit(0, 1, 1, 'x')]), {code: 'invalid_request'});
  assert.throws(() => applyTextEdits('x'.repeat(262_144), [edit(0, 0, 0, 'x')]), {code: 'budget_exceeded'});
  assert.throws(() => applyTextEdits('x', [{get range() {throw new Error('getter invoked');}, text: 'y'}]), {code: 'invalid_request'});
});

test('real HTTP project sessions preserve CAS conflicts, reload explicitly and never overwrite on create', async t => {
  const {client, root} = await fixture(t);
  const project = createWorkspaceProject(client); t.after(() => project.dispose());
  assert.equal(project.workspace.id, workspaceId);
  assert.equal((await project.listFiles()).entries[0].path, 'design.sv');
  const first = await project.openFile('design.sv'), second = await project.openFile('design.sv');
  const original = first.snapshot;
  const updated = await first.saveEdits([edit(0, 7, 13, 'updated')]);
  assert.equal(updated.content, 'module updated; endmodule\n');
  assert.notEqual(updated.revision, original.revision); assert.ok(Object.isFrozen(updated));
  await assert.rejects(second.save('stale'), {code: 'conflict'});
  assert.equal(second.state, 'needs-reload'); assert.equal(second.snapshot.content, original.content); assert.equal(second.snapshot.revision, original.revision);
  await assert.rejects(second.save('retry'), {code: 'conflict'});
  await second.reload(); assert.equal(second.snapshot.content, updated.content);
  await second.save('module final; endmodule\n');
  assert.equal(await readFile(join(root, 'design.sv'), 'utf8'), 'module final; endmodule\n');
  const created = await project.createFile('new.sv', '한글 😃\n');
  assert.equal(created.snapshot.content, '한글 😃\n');
  await assert.rejects(project.createFile('new.sv', 'overwrite'), {code: 'conflict'});
  assert.equal(await readFile(join(root, 'new.sv'), 'utf8'), '한글 😃\n');
});

test('read-only and protected-path checks reject writes without changing files', async t => {
  const {client, root} = await fixture(t, {writable: false});
  const project = createWorkspaceProject(client); t.after(() => project.dispose());
  const session = await project.openFile('design.sv');
  await assert.rejects(session.save('blocked'), {code: 'permission_denied'});
  await assert.rejects(project.createFile('new.sv', 'blocked'), {code: 'permission_denied'});
  assert.equal(session.state, 'ready');
  for (const path of ['../outside', '.env', '.ssh/key', '/outside', 'a\\b']) await assert.rejects(project.openFile(path), {code: 'unsafe_path'});
  assert.equal(await readFile(join(root, 'design.sv'), 'utf8'), 'module design; endmodule\n');
});

test('reconnect invalidates all old sessions even when workspace ID and generation are unchanged', async t => {
  const {client} = await fixture(t);
  const project = createWorkspaceProject(client), session = await project.openFile('design.sv');
  const before = client.binding; await client.connect();
  assert.deepEqual(client.binding.workspace, before.workspace);
  assert.equal(session.state, 'disposed');
  await assert.rejects(session.save('wrong connection'), {code: 'disposed'});
  await assert.rejects(project.openFile('design.sv'), {code: 'disposed'});
  assert.throws(() => session.snapshot, {code: 'disposed'});
  project.dispose(); assert.ok(client.binding, 'project disposal must not own the client');
  const next = createWorkspaceProject(client); assert.equal((await next.openFile('design.sv')).state, 'ready'); next.dispose();
});

test('cancelled or timed-out writes may have committed: require reload and reject concurrent saves', async t => {
  const {server, root} = await fixture(t);
  for (const mode of ['cancel', 'timeout']) {
    const arrived = deferred(), release = deferred(); let hold = true;
    const client = createWorkspaceClient({url: server.url, token, fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (JSON.parse(options.body).method === 'fs.write' && hold) {hold = false; arrived.resolve(); await release.promise;}
      return response;
    }});
    t.after(() => client.dispose()); await client.connect();
    const project = createWorkspaceProject(client), session = await project.openFile('design.sv');
    const abort = new AbortController();
    const pending = session.save(`committed-${mode}`, {signal: abort.signal, timeoutMs: mode === 'timeout' ? 1000 : 5000});
    const rejected = assert.rejects(pending, {code: mode === 'timeout' ? 'budget_exceeded' : 'cancelled'});
    await arrived.promise;
    assert.equal(session.state, 'saving');
    await assert.rejects(session.save('concurrent'), {code: 'conflict'});
    if (mode === 'cancel') abort.abort();
    await rejected; assert.equal(session.state, 'needs-reload');
    await assert.rejects(session.save('automatic-retry'), {code: 'conflict'});
    release.resolve();
    assert.equal(await readFile(join(root, 'design.sv'), 'utf8'), `committed-${mode}`);
    await session.reload(); assert.equal(session.snapshot.content, `committed-${mode}`);
    assert.equal(session.state, 'ready'); project.dispose();
  }
});

test('pre-cancelled saves leave session usable; disposing pending sessions discards late reads', async t => {
  const {server} = await fixture(t);
  const arrived = deferred(), release = deferred(); let hold = false;
  const client = createWorkspaceClient({url: server.url, token, fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (JSON.parse(options.body).method === 'fs.read' && hold) {arrived.resolve(); await release.promise;}
    return response;
  }});
  t.after(() => client.dispose()); await client.connect();
  const project = createWorkspaceProject(client), session = await project.openFile('design.sv');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(session.save('cancelled', {signal: abort.signal}), {code: 'cancelled'}); assert.equal(session.state, 'ready');
  hold = true;
  const pending = session.reload(), rejected = assert.rejects(pending, failure => ['cancelled', 'disposed'].includes(failure.code));
  await arrived.promise; session.dispose(); await rejected; release.resolve();
  assert.equal(session.state, 'disposed'); project.dispose();
});

test('session capacity reserves in-flight create operations before any file is written', async t => {
  const {server, root} = await fixture(t);
  const arrived = deferred(), release = deferred(); let reads = 0;
  const client = createWorkspaceClient({url: server.url, token, timeoutMs: 30000, fetch: async (url, options) => {
    const response = await fetch(url, options);
    if (JSON.parse(options.body).method === 'fs.read') {
      if (++reads === 64) arrived.resolve();
      await release.promise;
    }
    return response;
  }});
  t.after(() => client.dispose()); await client.connect();
  const project = createWorkspaceProject(client); t.after(() => project.dispose());
  const opening = Promise.all(Array.from({length: 64}, () => project.openFile('design.sv')));
  await arrived.promise;
  await assert.rejects(project.createFile('excess.sv', 'must not write'), {code: 'budget_exceeded'});
  await assert.rejects(readFile(join(root, 'excess.sv')), {code: 'ENOENT'});
  release.resolve(); const sessions = await opening;
  sessions[0].dispose(); const created = await project.createFile('fits.sv', 'ok'); assert.equal(created.snapshot.content, 'ok');
});
