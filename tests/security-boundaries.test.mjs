import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {request as httpRequest} from 'node:http';
import {createConnection} from 'node:net';
import {createNodeWorkspace, createWorkspaceServer} from '../src/workspace-node.mjs';
import {createWorkspaceClient} from '../src/workspace-client.mjs';
import {requireWorkspacePath, WORKSPACE_LIMITS} from '../src/workspace-protocol.mjs';

const token = 'security-fixture-token-'.repeat(3);
const workspaceId = 'fb0c6796-17cd-47f0-b1d6-2a090c3b4fea';
const notice = {id: 'security-fixture', version: '1', text: 'Synthetic local security fixture.'};
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dds-security-')));
  const root = path.join(directory, 'project');
  await fs.mkdir(root);
  const cleanup = [];
  t.after(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('dds-security-'));
    await fs.rm(directory, {recursive: true});
  });
  return {directory, root, cleanup};
}

test('workspace hardlinks cannot alias excluded or outside files through read, write, rename, remove or listing', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside.txt');
  await fs.writeFile(outside, 'synthetic outside content');
  await fs.writeFile(path.join(f.root, '.env'), 'synthetic excluded content');
  await fs.link(outside, path.join(f.root, 'outside-alias.txt'));
  await fs.link(path.join(f.root, '.env'), path.join(f.root, 'excluded-alias.txt'));
  const workspace = await createNodeWorkspace({root: f.root}); f.cleanup.push(() => workspace.dispose());
  for (const name of ['outside-alias.txt', 'excluded-alias.txt']) {
    await assert.rejects(workspace.readFile(name), {code: 'unsafe_path'});
    await assert.rejects(workspace.writeFile(name, 'replacement', {expectedRevision: 'a'.repeat(64)}), {code: 'unsafe_path'});
    await assert.rejects(workspace.rename(name, 'renamed.txt'), {code: 'unsafe_path'});
    await assert.rejects(workspace.remove(name), {code: 'unsafe_path'});
  }
  assert.deepEqual(await workspace.listFiles(), []);
  assert.equal(await fs.readFile(outside, 'utf8'), 'synthetic outside content');
  assert.equal(await fs.readFile(path.join(f.root, '.env'), 'utf8'), 'synthetic excluded content');
  await workspace.writeFile('ordinary.txt', 'safe', {expectedRevision: null});
  const ordinary = await workspace.readFile('ordinary.txt');
  await workspace.rename('ordinary.txt', 'renamed.txt', {expectedRevision: ordinary.revision});
  assert.equal((await workspace.readFile('renamed.txt')).content, 'safe');
});

test('workspace excludes credential stores, Windows device aliases and invalid Unicode before I/O', async t => {
  const f = await fixture(t);
  const workspace = await createNodeWorkspace({root: f.root}); f.cleanup.push(() => workspace.dispose());
  for (const name of ['.netrc', '_netrc', '.git-credentials', 'id_ecdsa_sk', 'id_ed25519_sk']) {
    await fs.writeFile(path.join(f.root, name), 'synthetic credential fixture');
    await assert.rejects(workspace.readFile(name), {code: 'unsafe_path'});
  }
  for (const name of ['.gnupg/keyring', '.kube/config', '.docker/config.json', 'COM\u00b9', 'LPT\u00b2.txt', 'dir/COM\u00b3.log', 'CONIN$', 'CONOUT$', 'bad\ud800.txt']) {
    assert.throws(() => requireWorkspacePath(name), {code: 'unsafe_path'});
    await assert.rejects(workspace.writeFile(name, 'text', {expectedRevision: null}), {code: 'unsafe_path'});
  }
  assert.deepEqual(await workspace.listFiles(), []);
});

test('rejected HTTP responses release unread response bodies', async t => {
  for (const options of [
    {status: 401}, {status: 403}, {status: 500}, {status: 302, headers: {location: 'https://other.example'}},
    {headers: {'content-type': 'text/plain'}},
    {headers: {'content-type': 'application/json', 'content-length': String(WORKSPACE_LIMITS.wireBytes + 1)}},
  ]) {
    let cancelled = 0;
    const body = new ReadableStream({cancel() { cancelled++; }});
    const response = new Response(body, options);
    const client = createWorkspaceClient({url: 'https://workspace.example', token, fetch: async () => response});
    t.after(async () => { client.dispose(); await body.cancel().catch(() => {}); });
    await assert.rejects(client.connect());
    assert.equal(cancelled, 1, `unread response leaked: ${JSON.stringify(options)}`);
  }
});

test('client timeout cancels a stalled response stream even when the transport ignores its signal', async t => {
  let cancelled = false;
  const body = new ReadableStream({cancel() { cancelled = true; }});
  const client = createWorkspaceClient({url: 'https://workspace.example', token, timeoutMs: 25,
    fetch: async () => new Response(body, {headers: {'content-type': 'application/json'}})});
  t.after(async () => { client.dispose(); await body.cancel().catch(() => {}); });
  await assert.rejects(client.connect(), {code: 'budget_exceeded'});
  assert.equal(cancelled, true);
});

test('excess headers cannot hide a denied Origin behind the parsed-header limit', async t => {
  const f = await fixture(t);
  const server = await createWorkspaceServer({root: f.root, workspaceId, token, notice});
  f.cleanup.push(() => server.close());
  const headers = {authorization: `Bearer ${token}`, 'content-type': 'application/json'};
  for (let index = 0; index < 40; index++) headers[`x-fixture-${index}`] = 'padding';
  headers.origin = 'https://denied.example';
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(server.url, {method: 'POST', agent: false, headers}, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(JSON.stringify({version: 1, requestId: 'header-fixture', method: 'hello', params: {}}));
  });
  assert.ok([400, 403, 431].includes(status), `excess headers were accepted: ${status}`);
});

test('HTTP body admission is bounded before buffering and a completed upload releases its slot', {timeout: 15000}, async t => {
  const f = await fixture(t);
  const server = await createWorkspaceServer({root: f.root, workspaceId, token, notice, timeoutMs: 30000});
  f.cleanup.push(() => server.close());
  const uploads = [];
  f.cleanup.push(() => { for (const {request} of uploads) request.destroy(); });
  const body = ' ' + JSON.stringify({version: 1, requestId: 'held-request', method: 'hello', params: {}});
  for (let index = 0; index < 16; index++) {
    await new Promise((resolve, reject) => {
      const request = httpRequest(server.url, {method: 'POST', agent: false, headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), expect: '100-continue',
      }});
      let finish;
      const response = new Promise(done => { finish = done; });
      request.on('response', value => { value.resume(); value.on('end', () => finish(value.statusCode)); });
      request.on('error', failure => { finish(0); reject(failure); });
      uploads.push({request, response});
      request.once('continue', () => { request.write(' '); resolve(); });
      request.flushHeaders();
    });
  }
  const hello = () => fetch(server.url, {method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: body.trimStart()});
  const saturated = await hello(); await saturated.arrayBuffer();
  assert.equal(saturated.status, 429);
  uploads[0].request.end(body.slice(1));
  assert.equal(await uploads[0].response, 200);
  const next = await hello();
  assert.equal(next.status, 200); assert.equal((await next.json()).ok, true);
});

test('unauthenticated connections are capped before any HTTP body is received', {timeout: 15000}, async t => {
  const f = await fixture(t);
  const server = await createWorkspaceServer({root: f.root, workspaceId, token, notice});
  f.cleanup.push(() => server.close());
  const port = Number(new URL(server.url).port), sockets = [];
  f.cleanup.push(() => { for (const socket of sockets) socket.destroy(); });
  for (let index = 0; index < 128; index++) {
    await new Promise((resolve, reject) => {
      const socket = createConnection({port, host: '127.0.0.1'});
      sockets.push(socket); socket.once('connect', resolve); socket.on('error', reject);
    });
  }
  await new Promise((resolve, reject) => {
    const socket = createConnection({port, host: '127.0.0.1'});
    sockets.push(socket);
    const timer = setTimeout(() => reject(new Error('Connection above the server limit remained open')), 2000);
    socket.on('error', () => {});
    socket.once('close', () => { clearTimeout(timer); resolve(); });
  });
});
