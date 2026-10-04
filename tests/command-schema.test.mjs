import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginHost, definePlugin, parseCommandDefinition, parseCommandInput, parseCommandOutput} from '../src/index.mjs';
import {DataValidationError} from '../src/data-schema.mjs';
import {createSecretResolver} from '../src/secrets.mjs';
import {deferred, hasCode} from './fixtures.mjs';

const schema = schema => ({schemaVersion: 1, schema});
const inputSchema = schema({type: 'object', additionalProperties: false, properties: {options: {type: 'object', additionalProperties: false, properties: {count: {type: 'integer', minimum: 1, maximum: 8, default: 2}, names: {type: 'array', items: {type: 'string', minLength: 1}, maxItems: 3}}, required: ['count', 'names']}}, required: ['options']});
const outputSchema = schema({type: 'object', additionalProperties: false, properties: {total: {type: 'integer', minimum: 0, default: 0}}, required: ['total']});
const command = {id: 'run', title: 'Run', inputSchema, outputSchema};
const manifest = {manifestVersion: 2, id: 'structured', name: 'Structured', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'workspace', capabilities: ['commands'], permissions: [], supportedHosts: ['workspace-host'], license: 'MIT', source: {visibility: 'open', licenseFile: 'LICENSE'}};
const flush = () => new Promise(resolve => setImmediate(resolve));
async function hostFor(handler, definition = command, options = {}, permissions = []) {
  const host = createPluginHost({hostId: 'workspace-host', jobs: true, ...options});
  await host.activate(definePlugin({...manifest, permissions}, context => context.registerCommand(definition, handler)));
  return host;
}
async function terminal(host, jobId) {for (let count = 0; count < 100; count++) {const snapshot = host.getJob(jobId); if (snapshot.state !== 'running') return snapshot; await flush();} assert.fail('Job did not settle');}
const validInput = {options: {names: ['Ada', '한글']}};

test('nested inputs apply defaults with stable paths; outputs never receive defaults', () => {
  assert.deepEqual(parseCommandInput(validInput, command), {options: {count: 2, names: ['Ada', '한글']}});
  assert.throws(() => parseCommandInput({options: {names: ['']}}, command), error => error instanceof DataValidationError && error.path === '/input/options/names/0' && error.reason === 'range');
  assert.throws(() => parseCommandOutput({}, command), error => error.path === '/output/total' && error.reason === 'required');
  assert.throws(() => parseCommandInput({options: {names: [], unknown: 'do-not-echo'}}, command), error => error.path === '/input/options' && !error.message.includes('do-not-echo'));
  assert.throws(() => parseCommandInput({options: {names: [], count: NaN}}, command), hasCode('invalid_contract'));
  assert.throws(() => parseCommandInput(JSON.parse('{"options":{"names":[],"__proto__":{}}}'), command), hasCode('invalid_contract'));
});

test('schema declaration rejects ambiguous legacy parameters, bad defaults and unsupported keywords', () => {
  assert.throws(() => parseCommandDefinition({...command, parameters: []}), hasCode('invalid_contract'));
  for (const bad of [{type: 'string', default: 2}, {type: 'string', pattern: '.*'}, {type: 'object', $ref: 'https://example.invalid/schema'}, {type: 'integer', maximum: Infinity}]) assert.throws(() => parseCommandDefinition({...command, inputSchema: schema(bad)}), hasCode('invalid_contract'));
  assert.deepEqual(parseCommandInput({name: 'Ada'}, {id: 'old', title: 'Old', parameters: [{name: 'name', label: 'Name', type: 'string', required: true}]}), {name: 'Ada'});
  assert.equal(parseCommandInput(null, {id: 'old', title: 'Old'}), null);
});

test('regular and job commands validate before execution and reject malformed output', async () => {
  let calls = 0; const host = await hostFor(input => {calls++; assert.equal(input.options.count, 2); return {total: input.options.names.length};});
  await assert.rejects(host.executeCommand('structured', 'run', {options: {names: [false]}}), hasCode('invalid_contract'));
  assert.throws(() => host.startCommandJob('structured', 'run', {} ,{jobId: crypto.randomUUID()}), hasCode('invalid_contract')); assert.equal(calls, 0);
  assert.deepEqual(await host.executeCommand('structured', 'run', validInput), {total: 2});
  const job = host.startCommandJob('structured', 'run', validInput, {jobId: crypto.randomUUID()}); assert.equal((await terminal(host, job.jobId)).result.total, 2); host.dispose();
  const wrong = await hostFor(() => ({total: 'sensitive provider value'}));
  await assert.rejects(wrong.executeCommand('structured', 'run', validInput), error => error.path === '/output/total' && !error.message.includes('sensitive'));
  const failed = await terminal(wrong, wrong.startCommandJob('structured', 'run', validInput, {jobId: crypto.randomUUID()}).jobId);
  assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'invalid_contract'); assert.equal(failed.result, undefined); assert.equal(JSON.stringify(failed).includes('sensitive'), false); wrong.dispose();
});

const secretCommand = {id: 'secret', title: 'Secret', inputSchema: schema({type: 'object', additionalProperties: false, properties: {token: {type: 'object', format: 'dds-secret-reference'}}, required: ['token']}), outputSchema: schema({type: 'boolean'})};
const issue = resolver => resolver.issue({secretId: 'operator-secret', pluginId: 'structured', workspaceId: 'example-project', commandIds: ['secret']});

test('secret references require explicit permission and a resolver before the command starts', async () => {
  let calls = 0; const resolver = createSecretResolver({authorize: () => true, resolve: () => new Uint8Array([1])}); const reference = issue(resolver);
  for (const [options, permissions, code] of [[{secrets: resolver}, [], 'permission_denied'], [{grants: ['secrets.resolve']}, ['secrets.resolve'], 'capability_unavailable']]) {
    const host = await hostFor(() => {calls++; return true;}, secretCommand, options, permissions);
    await assert.rejects(host.executeCommand('structured', 'secret', {token: reference}), hasCode(code));
    assert.throws(() => host.startCommandJob('structured', 'secret', {token: reference}, {jobId: crypto.randomUUID()}), hasCode(code)); host.dispose();
  }
  assert.equal(calls, 0); resolver.dispose();
});

test('each command execution binds reviewed references, current authority and clears secret bytes', async () => {
  let allowed = true, savedApi, bytes, currentReference; const executionIds = [];
  const resolver = createSecretResolver({authorize: () => allowed, resolve: request => {executionIds.push(request.scope.executionId); return new Uint8Array([1, 2, 3]);}});
  const reference = issue(resolver), foreign = issue(resolver); currentReference = reference;
  const host = await hostFor(async (_input, options) => {savedApi = options.secrets; await options.secrets.withSecret(currentReference, value => {bytes = value; assert.equal(value[1], 2);}); return true;}, secretCommand, {secrets: resolver, grants: ['secrets.resolve']}, ['secrets.resolve']);
  assert.equal(await host.executeCommand('structured', 'secret', {token: reference}), true); assert.deepEqual([...bytes], [0, 0, 0]);
  await assert.rejects(savedApi.withSecret(reference, () => {}), hasCode('disposed'));
  assert.equal((await terminal(host, host.startCommandJob('structured', 'secret', {token: reference}, {jobId: crypto.randomUUID()}).jobId)).state, 'succeeded');
  assert.equal(new Set(executionIds).size, 2);
  currentReference = foreign; await assert.rejects(host.executeCommand('structured', 'secret', {token: reference}), hasCode('permission_denied'));
  currentReference = reference; allowed = false; await assert.rejects(host.executeCommand('structured', 'secret', {token: reference}), hasCode('permission_denied'));
  allowed = true; resolver.revoke(reference); await assert.rejects(host.executeCommand('structured', 'secret', {token: reference}), hasCode('permission_denied'));
  host.dispose(); resolver.dispose();
});

test('secret provider errors are redacted and cancellation prevents late command success', async () => {
  const gate = deferred(), entered = deferred(); let bytes;
  const resolver = createSecretResolver({authorize: () => true, resolve: () => new Uint8Array([7])}); const reference = issue(resolver);
  const host = await hostFor(async (input, {secrets}) => {await secrets.withSecret(input.token, async value => {bytes = value; entered.resolve(); await gate.promise;}); return true;}, secretCommand, {secrets: resolver, grants: ['secrets.resolve']}, ['secrets.resolve']);
  const controller = new AbortController(), outcome = assert.rejects(host.executeCommand('structured', 'secret', {token: reference}, {signal: controller.signal}), hasCode('cancelled'));
  await entered.promise; controller.abort(); await outcome; assert.equal(bytes[0], 0); gate.resolve(); await flush(); host.dispose(); resolver.dispose();
  const broken = createSecretResolver({authorize: () => true, resolve: () => {throw new Error('secret fixture do not echo');}}), token = issue(broken);
  const redacted = await hostFor(async (input, {secrets}) => {await secrets.withSecret(input.token, () => {}); return true;}, secretCommand, {secrets: broken, grants: ['secrets.resolve']}, ['secrets.resolve']);
  await assert.rejects(redacted.executeCommand('structured', 'secret', {token}), error => error.code === 'provider_failed' && !error.message.includes('fixture') && error.cause === undefined); redacted.dispose(); broken.dispose();
});

test('secret port accessors are rejected without invoking foreign code', () => {
  let reads = 0;
  assert.throws(() => createPluginHost({secrets: {get withSecret() {reads++; return () => {};}}}), hasCode('invalid_contract'));
  assert.equal(reads, 0);
});
