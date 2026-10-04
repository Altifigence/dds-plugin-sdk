import test from 'node:test';
import assert from 'node:assert/strict';
import {createSettingsStore, parseSettingsDefinition, SETTINGS_LIMITS} from '../src/settings.mjs';
import {deferred, hasCode} from './fixtures.mjs';

const schema = node => ({schemaVersion: 1, schema: node});
const definition = () => ({schemaVersion: 1, pluginId: 'settings-demo', version: 1, settings: {
  count: {schema: schema({type: 'integer', minimum: 1, maximum: 10, default: 2}), scopes: ['user', 'workspace']},
  name: {schema: schema({type: 'string', default: 'default'}), scopes: ['user']},
  protocol: {schema: schema({type: 'integer', default: 1}), scopes: [], readOnly: true},
  credential: {schema: schema({type: 'object', format: 'dds-secret-reference'}), scopes: ['workspace']},
}});
const flush = () => new Promise(resolve => setImmediate(resolve));

test('settings precedence, whole-key reset, source and CAS preserve independent workspace values', () => {
  const store = createSettingsStore(definition());
  assert.deepEqual(store.read('first').values, {count: 2, name: 'default', protocol: 1});
  let view = store.update({workspaceId: 'first', scope: 'user', expectedRevision: 0, values: {count: 3, name: 'Ada'}});
  assert.equal(view.sources.count, 'user');
  view = store.update({workspaceId: 'first', scope: 'workspace', expectedRevision: 1, values: {count: 4}});
  assert.equal(view.values.count, 4); assert.equal(view.sources.count, 'workspace'); assert.equal(store.read('second').values.count, 3);
  const before = store.exportState();
  assert.throws(() => store.update({workspaceId: 'first', scope: 'workspace', expectedRevision: 1, values: {count: 5}}), hasCode('conflict'));
  assert.deepEqual(store.exportState(), before);
  view = store.update({workspaceId: 'first', scope: 'workspace', expectedRevision: 2, reset: ['count']});
  assert.equal(view.values.count, 3); assert.equal(view.sources.count, 'user');
  view = store.update({workspaceId: 'first', scope: 'user', expectedRevision: 3, reset: ['count']});
  assert.equal(view.values.count, 2); assert.equal(view.sources.count, 'default');
  assert.equal(store.update({workspaceId: 'first', scope: 'user', expectedRevision: 4}).revision, 4);
  store.dispose(); assert.throws(() => store.read('first'), hasCode('disposed'));
});

test('unknown, read-only and invalid settings fail atomically, and snapshots contain only typed references', () => {
  const store = createSettingsStore(definition()), ref = {kind: 'dds-secret-reference', id: crypto.randomUUID()};
  for (const values of [{count: 4, unknown: true}, {count: 11}, {protocol: 2}, {name: 'workspace cannot set this'}, {credential: 'secret-string'}]) assert.throws(() => store.update({workspaceId: 'w', scope: 'workspace', expectedRevision: 0, values}));
  assert.equal(store.read('w').revision, 0);
  store.update({workspaceId: 'w', scope: 'workspace', expectedRevision: 0, values: {credential: ref}});
  assert.deepEqual(store.read('w').values.credential, ref); assert.equal(store.read('other').values.credential, undefined);
  assert.throws(() => store.update({workspaceId: 'w', scope: 'user', expectedRevision: 1, values: {count: 3}, reset: ['count']}));
  assert.throws(() => store.update({workspaceId: 'w', scope: 'user', expectedRevision: 1, reset: ['deleted']}));
  assert.ok(Object.isFrozen(store.exportState().workspaces.w.credential)); store.dispose();
});

test('coalesced subscriptions are removable and isolate failing callbacks', async () => {
  const store = createSettingsStore(definition()), first = [], second = [], removed = [];
  store.subscribe('w', view => first.push(view)); store.subscribe('other', view => second.push(view));
  store.subscribe('w', () => {throw new Error('Subscriber private text');}); const unsubscribe = store.subscribe('w', v => removed.push(v));
  store.update({workspaceId: 'w', scope: 'user', expectedRevision: 0, values: {count: 3}});
  store.update({workspaceId: 'w', scope: 'workspace', expectedRevision: 1, values: {count: 4}});
  unsubscribe.dispose(); await flush();
  assert.equal(first.length, 1); assert.equal(first[0].values.count, 4); assert.equal(second[0].values.count, 3); assert.deepEqual(removed, []);
  store.dispose(); assert.throws(() => store.inspect(), hasCode('disposed'));
});

test('explicit migrations validate changed/deleted keys and preserve valid state on error', async () => {
  const store = createSettingsStore(definition());
  store.update({workspaceId: 'w', scope: 'user', expectedRevision: 0, values: {count: 3}});
  const next = definition(); next.version = 2; delete next.settings.count; next.settings.total = {schema: schema({type: 'integer', default: 5}), scopes: ['user', 'workspace']};
  const before = store.exportState();
  await assert.rejects(store.migrate(next, () => {throw new Error('private provider material');}, {expectedRevision: 1}), e => e.code === 'provider_failed' && !e.message.includes('private'));
  await assert.rejects(store.migrate(next, old => ({user: old.user, workspaces: old.workspaces}), {expectedRevision: 1}));
  assert.deepEqual(store.exportState(), before);
  const result = await store.migrate(next, old => ({user: {total: old.user.count}, workspaces: {}}), {expectedRevision: 1});
  assert.equal(result.definitionVersion, 2); assert.equal(result.revision, 2); assert.equal(store.read('w').values.total, 3); assert.equal(store.read('w').values.count, undefined);
  await assert.rejects(store.migrate(next, () => ({}), {expectedRevision: 2}), hasCode('version_mismatch')); store.dispose();
});

test('a concurrent update defeats a pending migration without losing either previously valid definition or user edit', async () => {
  const store = createSettingsStore(definition()), gate = deferred(), next = {...definition(), version: 2};
  const pending = store.migrate(next, () => gate.promise, {expectedRevision: 0}); await flush();
  store.update({workspaceId: 'w', scope: 'user', expectedRevision: 0, values: {count: 8}}); gate.resolve({user: {count: 5}, workspaces: {}});
  await assert.rejects(pending, hasCode('conflict')); assert.equal(store.definition.version, 1); assert.equal(store.read('w').values.count, 8); store.dispose();
});

test('ignored migration cancellation holds its actual slot and cannot commit a late value', async () => {
  const store = createSettingsStore(definition()), gate = deferred(), next = {...definition(), version: 2};
  await assert.rejects(store.migrate(next, () => gate.promise, {expectedRevision: 0, timeoutMs: 5}), hasCode('budget_exceeded'));
  assert.equal(store.inspect().pendingMigrations, 1);
  await assert.rejects(store.migrate(next, () => ({user: {}, workspaces: {}}), {expectedRevision: 0}), hasCode('budget_exceeded'));
  gate.resolve({user: {count: 9}, workspaces: {}}); await flush();
  assert.equal(store.inspect().pendingMigrations, 0); assert.equal(store.definition.version, 1); assert.equal(store.read('w').values.count, 2);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(store.migrate(next, () => ({}), {expectedRevision: 0, signal: abort.signal}), hasCode('cancelled')); store.dispose();
});

test('import and bounds reject incompatible or excessive state and release subscription resources', () => {
  const store = createSettingsStore(definition());
  for (let i = 0; i < SETTINGS_LIMITS.workspaces; i++) store.update({workspaceId: 'workspace-'+i, scope: 'workspace', expectedRevision: i, values: {count: 3}});
  assert.throws(() => store.update({workspaceId: 'overflow', scope: 'workspace', expectedRevision: SETTINGS_LIMITS.workspaces, values: {count: 3}}), hasCode('budget_exceeded'));
  const restored = createSettingsStore(definition(), {state: store.exportState()}); assert.deepEqual(restored.exportState(), store.exportState());
  assert.throws(() => createSettingsStore({...definition(), version: 2}, {state: store.exportState()}), hasCode('version_mismatch'));
  const disposables = Array.from({length: SETTINGS_LIMITS.subscriptions}, () => store.subscribe('w', () => {}));
  assert.throws(() => store.subscribe('w', () => {}), hasCode('budget_exceeded')); disposables.forEach(x => x.dispose()); assert.equal(store.inspect().subscriptions, 0);
  const bad = definition(); bad.settings.protocol.scopes = ['user']; assert.throws(() => parseSettingsDefinition(bad));
  store.dispose(); restored.dispose();
});
