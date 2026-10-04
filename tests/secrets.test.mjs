import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecretResolver, createSecretExecution, parseSecretReference, SECRET_LIMITS} from '../src/secrets.mjs';
import {createSettingsStore} from '../src/settings.mjs';
import {deferred, hasCode} from './fixtures.mjs';

const execution = () => ({pluginId: 'secret-demo', workspaceId: 'workspace', commandId: 'analyze', executionId: crypto.randomUUID()});
const issue = (resolver, extra = {}) => resolver.issue({secretId: 'operator-key', pluginId: 'secret-demo', workspaceId: 'workspace', commandIds: ['analyze'], ...extra});
const flush = () => new Promise(resolve => setImmediate(resolve));
const material = () => new TextEncoder().encode('disposable-fixture-'+crypto.randomUUID());

test('secret values stay out of references and settings, and an execution lease clears its owned bytes', async () => {
  const original = material(), requests = [], policies = []; let retained;
  const resolver = createSecretResolver({resolve(request) {requests.push(request); return original;}, authorize(request) {policies.push(request); return true;}});
  const ref = issue(resolver), expected = new TextDecoder().decode(original);
  const store = createSettingsStore({schemaVersion: 1, pluginId: 'secret-demo', version: 1, settings: {credential: {schema: {schemaVersion: 1, schema: {type: 'object', format: 'dds-secret-reference'}}, scopes: ['workspace']}}});
  store.update({workspaceId: 'workspace', scope: 'workspace', expectedRevision: 0, values: {credential: ref}});
  const current = execution();
  await resolver.withSecret(ref, current, bytes => {retained = bytes; assert.equal(new TextDecoder().decode(bytes), expected);});
  assert.ok(retained.every(byte => byte === 0)); assert.equal(new TextDecoder().decode(original), expected);
  assert.equal(requests[0].secretId, 'operator-key'); assert.deepEqual(requests[0].scope, current); assert.ok(policies.length >= 3);
  assert.equal(JSON.stringify([ref, store.exportState(), resolver.inspect(), policies]).includes(expected), false);
  assert.deepEqual(Object.keys(ref).sort(), ['id', 'kind']); resolver.dispose(); store.dispose();
});

test('plugin, workspace, command, malformed and unknown reference scopes are denied before resolution', async () => {
  let resolutions = 0;
  const resolver = createSecretResolver({resolve() {resolutions++; return material();}, authorize: () => true}), ref = issue(resolver);
  for (const changes of [{pluginId: 'other'}, {workspaceId: 'other'}, {commandId: 'other'}]) await assert.rejects(resolver.withSecret(ref, {...execution(), ...changes}, () => {}), hasCode('permission_denied'));
  await assert.rejects(resolver.withSecret({kind: 'dds-secret-reference', id: crypto.randomUUID()}, execution(), () => {}), hasCode('permission_denied'));
  await assert.rejects(resolver.withSecret(ref, {...execution(), executionId: 'not-an-execution'}, () => {}), hasCode('invalid_contract'));
  for (const bad of [{...ref, value: 'inline'}, ref.id, {...ref, id: ref.id.toUpperCase()}]) assert.throws(() => parseSecretReference(bad));
  assert.equal(resolutions, 0); resolver.dispose();
});

test('current approval is rechecked after resolve, and provider/consumer failures are redacted', async () => {
  let permitted = true; const gate = deferred(), hidden = new TextDecoder().decode(material());
  const resolver = createSecretResolver({resolve: () => gate.promise, authorize: () => permitted}), ref = issue(resolver);
  let called = false;
  const pending = resolver.withSecret(ref, execution(), () => {called = true;}); await flush(); permitted = false; gate.resolve(material());
  await assert.rejects(pending, hasCode('permission_denied')); assert.equal(called, false); resolver.dispose();
  const bad = createSecretResolver({resolve() {throw new Error(hidden);}, authorize: () => true}), badRef = issue(bad);
  await assert.rejects(bad.withSecret(badRef, execution(), () => {}), e => e.code === 'provider_failed' && !String(e.stack).includes(hidden) && !JSON.stringify(e).includes(hidden)); bad.dispose();
  const consumer = createSecretResolver({resolve: material, authorize: () => true}), consumerRef = issue(consumer); let bytes;
  await assert.rejects(consumer.withSecret(consumerRef, execution(), b => {bytes = b; throw new Error(hidden);}), e => e.code === 'provider_failed' && !String(e).includes(hidden));
  assert.ok(bytes.every(x => x === 0));
  await assert.rejects(consumer.withSecret(consumerRef, execution(), b => new TextDecoder().decode(b)), hasCode('invalid_contract')); consumer.dispose();
});

test('expiry and revocation stop new uses and abort/clear an ongoing consumer lease', async () => {
  let now = 1000;
  const resolver = createSecretResolver({resolve: material, authorize: () => true, now: () => now}), expired = issue(resolver, {ttlMs: 10});
  now = 1010; await assert.rejects(resolver.withSecret(expired, execution(), () => {}), hasCode('permission_denied'));
  assert.equal(resolver.inspect().references, 0);
  const ref = issue(resolver), gate = deferred(), entered = deferred(); let leased, leaseSignal;
  const pending = resolver.withSecret(ref, execution(), async (bytes, {signal}) => {leased = bytes; leaseSignal = signal; entered.resolve(); await gate.promise;});
  await entered.promise; assert.ok(leased.some(x => x !== 0)); assert.equal(resolver.revoke(ref), true);
  await assert.rejects(pending, hasCode('permission_denied')); assert.equal(leaseSignal.aborted, true); assert.ok(leased.every(x => x === 0));
  assert.equal(resolver.inspect().pending, 1); gate.resolve(); await flush(); assert.equal(resolver.inspect().pending, 0);
  await assert.rejects(resolver.withSecret(ref, execution(), () => {}), hasCode('permission_denied')); assert.equal(resolver.revoke(ref), false); resolver.dispose();
});

test('real expiry timers abort pending resolution without delivering a late secret', async () => {
  const gate = deferred(); const resolver = createSecretResolver({resolve: () => gate.promise, authorize: () => true}), ref = issue(resolver, {ttlMs: 25}); let calls = 0;
  await assert.rejects(resolver.withSecret(ref, execution(), () => {calls++;}), hasCode('permission_denied'));
  gate.resolve(material()); await flush(); assert.equal(calls, 0); assert.equal(resolver.inspect().pending, 0); resolver.dispose();
});

test('ignored resolve cancellation retains the actual concurrency budget until providers settle', async () => {
  const gates = Array.from({length: SECRET_LIMITS.pending}, deferred); let started = 0, used = 0;
  const resolver = createSecretResolver({resolve: () => gates[started++].promise, authorize: () => true}), ref = issue(resolver);
  await Promise.all(gates.map(() => assert.rejects(resolver.withSecret(ref, execution(), () => {used++;}, {timeoutMs: 10}), hasCode('budget_exceeded'))));
  assert.equal(started, SECRET_LIMITS.pending); assert.equal(resolver.inspect().pending, SECRET_LIMITS.pending);
  await assert.rejects(resolver.withSecret(ref, execution(), () => {}), hasCode('budget_exceeded'));
  gates.forEach(gate => gate.resolve(material())); await flush(); assert.equal(resolver.inspect().pending, 0); assert.equal(used, 0); resolver.dispose();
});

test('reference count, material size and provider types are bounded without invoking byte hooks', async () => {
  let now = 1000;
  const resolver = createSecretResolver({resolve: material, authorize: () => true, now: () => now});
  for (let i = 0; i < SECRET_LIMITS.references; i++) issue(resolver, {ttlMs: 5});
  assert.throws(() => issue(resolver), hasCode('budget_exceeded')); now += 5; const fresh = issue(resolver); assert.equal(resolver.inspect().references, 1); resolver.dispose();
  for (const value of [new Uint8Array(), new Uint8Array(SECRET_LIMITS.valueBytes + 1), 'string-material', {bytes: [1, 2]}]) {
    const invalid = createSecretResolver({resolve: () => value, authorize: () => true}); await assert.rejects(invalid.withSecret(issue(invalid), execution(), () => {}), hasCode('invalid_contract')); invalid.dispose();
  }
  let hooks = 0;
  class HostileBytes extends Uint8Array {get byteLength() {hooks++; throw new Error('private');} [Symbol.iterator]() {hooks++; throw new Error('private');}}
  const special = createSecretResolver({resolve: () => new HostileBytes([1, 2, 3]), authorize: () => true});
  await special.withSecret(issue(special), execution(), bytes => {assert.deepEqual([...bytes], [1, 2, 3]);}); assert.equal(hooks, 0); special.dispose();
  assert.equal(parseSecretReference(fresh).kind, 'dds-secret-reference');
});

test('execution bindings allow only reviewed references, close deterministically and redact custom port errors', async () => {
  const resolver = createSecretResolver({resolve: material, authorize: () => true}), ref = issue(resolver), other = issue(resolver);
  const bound = createSecretExecution(resolver, execution(), [ref]); let used = 0;
  await bound.secrets.withSecret(ref, () => {used++;}); assert.equal(used, 1);
  await assert.rejects(bound.secrets.withSecret(other, () => {}), hasCode('permission_denied'));
  bound.dispose(); await assert.rejects(bound.secrets.withSecret(ref, () => {}), hasCode('disposed'));
  const hidden = new TextDecoder().decode(material()), custom = createSecretExecution({withSecret() {throw new Error(hidden);}}, execution(), [ref]);
  await assert.rejects(custom.secrets.withSecret(ref, () => {}), e => e.code === 'provider_failed' && !String(e).includes(hidden)); custom.dispose();
  const cancelled = new AbortController(), stopped = createSecretExecution(resolver, execution(), [ref], {signal: cancelled.signal}); cancelled.abort();
  await assert.rejects(stopped.secrets.withSecret(ref, () => {}), hasCode('cancelled')); stopped.dispose(); resolver.dispose();
});
