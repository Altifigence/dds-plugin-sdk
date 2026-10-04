import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginHost, createLanguageResult, createLanguageRegistry, parseLanguageRequest, parseLanguageResult, parseManifest, definePlugin, LANGUAGE_FEATURES, LIMITS} from '../src/index.mjs';
import {deferred, document, request as baseRequest, hasCode} from './fixtures.mjs';
import example from '../examples/hello-language/plugin.mjs';

const range = {start: {line: 0, character: 0}, end: {line: 0, character: 4}};
const payload = {completion: [{label: 'hello', insertText: 'hello', range}], hover: {text: '<b>plain text</b>', range}, definition: [{path: 'other.sv', range}], references: [{path: 'other.sv', range}], 'document-symbols': [{name: 'hello', kind: 'variable', range, selectionRange: range}]};
const input = kind => kind === 'document-symbols' ? {} : {position: {line: 0, character: 1}};
const request = kind => ({...baseRequest, kind, ...input(kind)});
const manifest = {...example.manifest, supportedHosts: ['test-host', 'workspace-host']};
function plugin(kind, provide = req => createLanguageResult(req, payload[kind]), extra = {}) {
  return definePlugin({...manifest, capabilities: [kind], ...extra}, context => context.registerLanguageProvider(kind, {languages: ['plaintext']}, {provide}));
}
async function hostFor(kind, provide, extra) {
  const host = createPluginHost({grants: ['document.read', 'language.provide']});
  await host.activate(plugin(kind, provide, extra)); host.setDocument(document); return host;
}

for (const kind of Object.keys(payload)) {
  test(`${kind}: immutable scoped contracts and host result`, async () => {
    const req = parseLanguageRequest(JSON.stringify(request(kind)));
    const result = createLanguageResult(req, payload[kind]);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.data));
    assert.deepEqual(parseLanguageResult(JSON.stringify(result)), result);
    const host = await hostFor(kind);
    try { assert.deepEqual((await host.requestLanguage(kind, input(kind))).data, payload[kind]); }
    finally { host.dispose(); }
  });
  test(`${kind}: edit, unregister, deactivate and host disposal abort ignored late results`, async () => {
    for (const action of ['edit', 'unregister', 'deactivate', 'dispose']) {
      const started = deferred(), finish = deferred(); let signal, registration;
      const host = createPluginHost({grants: ['document.read', 'language.provide']});
      await host.activate(definePlugin(manifest, context => {
        registration = context.registerLanguageProvider(kind, {languages: ['plaintext']}, {async provide(req, options) {
          signal = options.signal; started.resolve(); await finish.promise; return createLanguageResult(req, payload[kind]);
        }});
      }));
      host.setDocument(document);
      const pending = host.requestLanguage(kind, input(kind));
      const rejection = assert.rejects(pending, hasCode(action === 'edit' ? 'stale_snapshot' : 'disposed'));
      await started.promise;
      if (action === 'edit') host.setDocument({...document, modelVersion: 2, text: 'changed'});
      else if (action === 'unregister') registration.dispose();
      else if (action === 'deactivate') host.deactivate(manifest.id);
      else host.dispose();
      await rejection; assert.ok(signal.aborted); finish.resolve(); host.dispose();
    }
  });
}

test('language capabilities require declaration and explicit fresh grants; v1 remains unchanged', async () => {
  for (const grants of [[], ['document.read'], ['language.provide']]) {
    const host = createPluginHost({grants});
    await assert.rejects(host.activate(plugin('completion')), hasCode('permission_denied')); host.dispose();
  }
  const host = createPluginHost({grants: ['document.read', 'language.provide']});
  await assert.rejects(host.activate(plugin('completion', undefined, {capabilities: ['hover']})), hasCode('permission_denied'));
  await assert.rejects(host.activate(plugin('completion', undefined, {permissions: ['document.read']})), hasCode('permission_denied'));
  host.dispose();
  const {runtime, source, ...v1} = manifest;
  assert.throws(() => parseManifest({...v1, manifestVersion: 1}), hasCode('invalid_contract'));
});

test('language contracts reject wrong positions, traversal, executable fields and oversized data without reading getters', () => {
  for (const position of [{line: 99, character: 0}, {line: 0, character: 99}, {line: -1, character: 0}]) assert.throws(() => parseLanguageRequest({...request('hover'), position}), hasCode('invalid_contract'));
  assert.throws(() => parseLanguageRequest({...request('document-symbols'), position: range.start}), hasCode('invalid_contract'));
  assert.throws(() => parseLanguageRequest({...request('hover'), includeDeclaration: false}), hasCode('invalid_contract'));
  assert.throws(() => parseLanguageRequest({...request('hover'), protocolVersion: 2}), hasCode('version_mismatch'));
  for (const path of ['../outside', '/etc/passwd', 'command:run', 'a\\b']) assert.throws(() => createLanguageResult(request('definition'), [{path, range}]), hasCode('invalid_contract'));
  assert.throws(() => createLanguageResult(request('completion'), [{label: 'x', insertText: 'x', command: 'execute'}]), hasCode('invalid_contract'));
  assert.throws(() => createLanguageResult(request('completion'), Array(LIMITS.maxLanguageItems + 1).fill(payload.completion[0])), hasCode('invalid_contract'));
  assert.throws(() => createLanguageResult(request('completion'), Array(100).fill({label: 'x', insertText: 'x'.repeat(16_384)})), hasCode('budget_exceeded'));
  assert.throws(() => createLanguageResult(request('hover'), {get text() {throw new Error('getter executed');}}), hasCode('invalid_contract'));
  const outside = {start: {line: 0, character: 4}, end: {line: 0, character: 5}};
  assert.throws(() => createLanguageResult(request('document-symbols'), [{...payload['document-symbols'][0], selectionRange: outside}]), hasCode('invalid_contract'));
});

test('language host rejects forged identities, feature type and same-document range after provider returns', async () => {
  for (const [mutate, code] of [
    [result => ({...result, requestId: 'other'}), 'stale_snapshot'],
    [result => ({...result, scope: {...result.scope, sessionId: 'other'}}), 'stale_snapshot'],
    [result => ({...result, snapshot: {...result.snapshot, modelVersion: 99}}), 'stale_snapshot'],
    [result => ({...result, kind: 'completion', data: []}), 'invalid_contract'],
    [result => ({...result, data: {text: 'outside', range: {start: {line: 99, character: 0}, end: {line: 99, character: 0}}}}), 'invalid_contract'],
  ]) {
    const host = await hostFor('hover', req => mutate(createLanguageResult(req, null)));
    await assert.rejects(host.requestLanguage('hover', input('hover')), hasCode(code)); host.dispose();
  }
});

test('language cancellation, timeout and sanitized failure use the shared lifecycle', async () => {
  let calls = 0;
  const host = await hostFor('hover', () => {calls++; return new Promise(() => {});});
  const pre = new AbortController(); pre.abort();
  await assert.rejects(host.requestLanguage('hover', input('hover'), {signal: pre.signal}), hasCode('cancelled'));
  assert.equal(calls, 0);
  const abort = new AbortController();
  const pending = host.requestLanguage('hover', input('hover'), {signal: abort.signal}); abort.abort();
  await assert.rejects(pending, hasCode('cancelled'));
  await assert.rejects(host.requestLanguage('hover', input('hover'), {timeoutMs: 5}), hasCode('budget_exceeded'));
  host.dispose();
  const broken = await hostFor('hover', () => {throw new Error('provider-private-detail');});
  await assert.rejects(broken.requestLanguage('hover', input('hover')), error => error.code === 'provider_failed' && !error.message.includes('private-detail'));
  broken.dispose();
});

test('standalone language registry enforces kind and stable priority with fallback on disposal', async () => {
  const registry = createLanguageRegistry('hover');
  registry.register('first', {languages: ['plaintext']}, {provide: req => createLanguageResult(req, {text: 'first'})});
  const high = registry.register('high', {languages: ['plaintext'], priority: 1}, {provide: req => createLanguageResult(req, {text: 'high'})});
  assert.equal((await registry.request(request('hover'))).data.text, 'high');
  high.dispose(); high.dispose();
  assert.equal((await registry.request(request('hover'))).data.text, 'first');
  await assert.rejects(registry.request(request('completion')), hasCode('invalid_contract'));
  registry.dispose();
});
