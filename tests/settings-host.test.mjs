import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginHost, definePlugin, LIMITS} from '../src/index.mjs';
import {createSettingsStore} from '../src/settings.mjs';
import {hasCode, deferred} from './fixtures.mjs';

const definition = {schemaVersion: 1, pluginId: 'settings-demo', version: 1, settings: {count: {schema: {schemaVersion: 1, schema: {type: 'integer', default: 2}}, scopes: ['user', 'workspace']}}};
const manifest = {manifestVersion: 2, id: 'settings-demo', name: 'Settings', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', capabilities: ['settings', 'commands'], permissions: ['settings.read'], supportedHosts: ['test-host'], license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'}};
const flush = () => new Promise(resolve => setImmediate(resolve));

test('host settings are scoped, granted and read-only, and deactivation removes subscriptions', async () => {
  const store = createSettingsStore(definition), events = []; let context;
  const host = createPluginHost({scope: {projectId: 'selected', sessionId: 'session'}, grants: ['settings.read'], settings: {'settings-demo': store}});
  await host.activate(definePlugin(manifest, value => {context = value; value.settings.subscribe(view => events.push(view));}));
  assert.equal((await context.settings.read()).workspaceId, 'selected'); assert.equal(context.settings.update, undefined);
  store.update({workspaceId: 'foreign', scope: 'workspace', expectedRevision: 0, values: {count: 9}}); await flush();
  assert.equal(events[0].workspaceId, 'selected'); assert.equal(events[0].values.count, 2);
  store.update({workspaceId: 'selected', scope: 'workspace', expectedRevision: 1, values: {count: 4}}); await flush(); assert.equal(events[1].values.count, 4);
  host.deactivate('settings-demo'); assert.equal(store.inspect().subscriptions, 0); await assert.rejects(context.settings.read(), hasCode('disposed')); host.dispose(); store.dispose();
});

test('settings require both declaration and grant, and existing plugins require no port', async () => {
  const store = createSettingsStore(definition);
  for (const [changes, grants, expected] of [[{}, [], 'permission_denied'], [{permissions: []}, ['settings.read'], 'permission_denied'], [{capabilities: ['commands']}, ['settings.read'], 'permission_denied']]) {
    let context; const host = createPluginHost({grants, settings: {'settings-demo': store}});
    await host.activate(definePlugin({...manifest, ...changes}, value => {context = value;})); await assert.rejects(context.settings.read(), hasCode(expected)); host.dispose();
  }
  let context; const missing = createPluginHost({grants: ['settings.read']}); await missing.activate(definePlugin(manifest, value => {context = value;})); await assert.rejects(context.settings.read(), hasCode('capability_unavailable')); missing.dispose();
  const legacy = createPluginHost(); await legacy.activate(definePlugin({...manifest, capabilities: ['commands'], permissions: []}, context => context.registerCommand({id: 'run', title: 'Run'}, () => 'old command')));
  assert.equal(await legacy.executeCommand('settings-demo', 'run', {}), 'old command'); legacy.dispose(); store.dispose();
});

test('foreign port replies and notifications are rejected, including synchronous registration callbacks', async () => {
  const store = createSettingsStore(definition); let context, disposed = 0, deliveries = 0;
  const host = createPluginHost({grants: ['settings.read'], settings: {'settings-demo': {
    read: () => store.read('foreign'),
    subscribe(_workspace, callback) {callback(store.read('foreign')); return {dispose() {disposed++;}};},
  }}});
  await host.activate(definePlugin(manifest, value => {context = value;})); await assert.rejects(context.settings.read(), hasCode('permission_denied'));
  context.settings.subscribe(() => {deliveries++;}); assert.equal(deliveries, 0); assert.equal(disposed, 1); host.dispose(); store.dispose();
});

test('pending host settings reads discard results after deactivation and retain actual request budgets', async () => {
  const gates = Array.from({length: LIMITS.maxPendingRequests}, deferred); let started = 0, context;
  const store = createSettingsStore(definition), host = createPluginHost({grants: ['settings.read'], settings: {'settings-demo': {read() {return gates[started++].promise;}}}});
  await host.activate(definePlugin(manifest, value => {context = value;}));
  await Promise.all(gates.map(() => assert.rejects(context.settings.read({timeoutMs: 10}), hasCode('budget_exceeded'))));
  assert.equal(started, LIMITS.maxPendingRequests); await assert.rejects(context.settings.read(), hasCode('budget_exceeded'));
  host.deactivate('settings-demo'); gates.forEach(g => g.resolve(store.read('example-project'))); await flush(); await assert.rejects(context.settings.read(), hasCode('disposed')); host.dispose(); store.dispose();
});

test('custom class ports work, while port accessors are never invoked', async () => {
  const store = createSettingsStore(definition); class Port {read(id) {return store.read(id);}}
  let context; const host = createPluginHost({grants: ['settings.read'], settings: {'settings-demo': new Port()}});
  await host.activate(definePlugin(manifest, value => {context = value;})); assert.equal((await context.settings.read()).values.count, 2); host.dispose();
  let calls = 0; assert.throws(() => createPluginHost({settings: {'settings-demo': {get read() {calls++; return () => null;}}}}), hasCode('invalid_contract')); assert.equal(calls, 0); store.dispose();
});
