import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginHost, createLanguageRegistry, definePlugin, createLanguageResult, parseLanguageRequest, parseSignatureHelp, parseSnippet, parseCompletionItem, parseManifest, LANGUAGE_LIMITS, LIMITS} from '../src/index.mjs';
import {deferred, hasCode} from './fixtures.mjs';
import {SDK_VERSION} from '../src/version.mjs';
import {readFile} from 'node:fs/promises';

const snapshot = {uri: 'memory:///demo.dds', languageId: 'dds-demo', modelVersion: 1, workspaceRevision: 'one', text: 'let 😀 = 1;\r\nsu'};
const position = {line: 1, character: 2};
const range = {start: {line: 1, character: 0}, end: position};
const item = {label: 'sum', insertText: 'sum(${1:left}, ${2:right})$0', range, insertTextFormat: 'snippet', resolveData: {symbol: 'sum'}};
const signature = {signatures: [{label: 'sum(left, right)', parameters: [{label: [4, 8]}, {label: [10, 15]}]}], activeSignature: 0, activeParameter: 1};
const manifest = {manifestVersion: 2, id: 'assistance', name: 'Assistance', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', capabilities: ['completion', 'signature-help', 'completion-resolve', 'completion-snippets'], permissions: ['document.read', 'language.provide'], supportedHosts: ['test-host'], license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'}};
async function fixture(t, {provide = request => createLanguageResult(request, [item]), resolve = (_request, selected) => ({...selected, documentation: '<b>Plain text only</b>'}), capabilities = manifest.capabilities} = {}) {
  const host = createPluginHost({grants: ['document.read', 'language.provide']}); t.after(() => host.dispose());
  let registration;
  await host.activate(definePlugin({...manifest, capabilities}, context => {
    registration = context.registerLanguageProvider('completion', {languages: ['dds-demo']}, {provide, ...(resolve ? {resolve} : {})});
    if (capabilities.includes('signature-help')) context.registerLanguageProvider('signature-help', {languages: ['dds-demo']}, {provide: request => createLanguageResult(request, signature)});
  }));
  host.setDocument(snapshot);
  return {host, registration, request: () => host.requestLanguage('completion', {position})};
}

test('snippets expand forward mirrors, Unicode, CRLF and escaped literals into bounded ordered stops', () => {
  const parsed = parseSnippet('$2:${1:😀}\r\n${2:x}-$1$0');
  assert.equal(parsed.text, 'x:😀\r\nx-😀');
  assert.deepEqual(parsed.tabstops.map(x => x.index), [1, 2, 0]);
  assert.deepEqual(parsed.tabstops[0].ranges, [{start: 2, end: 4}, {start: 8, end: 10}]);
  assert.equal(parseSnippet(String.raw`\$ \{ \} \\`).text, '$ { } \\');
  assert.deepEqual(parseSnippet('').tabstops, [{index: 0, ranges: [{start: 0, end: 0}]}]);
  assert.ok(Object.isFrozen(parsed.tabstops[0].ranges));
});

test('snippets reject variables, transforms, nesting, malformed escapes, inconsistent mirrors and over-expansion', () => {
  for (const text of ['$NAME', '${name}', '${1:x${2:y}}', '${1|a,b|}', '${1/a/b/}', '$01', '$100', '${0:x}', '$0$0', '${1:x}${1:y}', '${1:x', '$', '\\q', '${1:\r}\n', '${1:😀}$1'.repeat(65)]) assert.throws(() => parseSnippet(text), hasCode('invalid_contract'), text);
  assert.throws(() => parseSnippet('${1:' + 'x'.repeat(9000) + '}$1'), hasCode('invalid_contract'));
  assert.throws(() => parseSnippet('x'.repeat(LANGUAGE_LIMITS.snippetChars + 1)), hasCode('invalid_contract'));
  assert.throws(() => parseSnippet('$1'.repeat(LANGUAGE_LIMITS.snippetStops + 1)), hasCode('invalid_contract'));
});

test('signature help preserves context, overloads and UTF-16 labels; malformed active parameter is rejected', async t => {
  const {host} = await fixture(t);
  const result = await host.requestLanguage('signature-help', {position, context: {triggerKind: 'character', triggerCharacter: ',', isRetrigger: true, activeSignature: 0, activeParameter: 0}});
  assert.deepEqual(result.data, signature);
  assert.equal(host.languageCapabilities().snippets, true);
  assert.equal(parseSignatureHelp({signatures: [{label: 'now()', parameters: []}], activeSignature: 0, activeParameter: null}).activeParameter, null);
  for (const invalid of [{...signature, activeSignature: 1}, {...signature, activeParameter: 2}, {...signature, activeParameter: null}, {...signature, signatures: [{label: '😀x', parameters: [{label: [1, 2]}]}]}, {...signature, command: 'run'}]) assert.throws(() => parseSignatureHelp(invalid), hasCode('invalid_contract'));
  const request = {protocolVersion: 1, requestId: 'one', scope: {projectId: 'p', sessionId: 's'}, snapshot, kind: 'signature-help', position};
  for (const context of [{triggerKind: 'character', triggerCharacter: 'xx', isRetrigger: false}, {triggerKind: 'invoked', triggerCharacter: ',', isRetrigger: false}, {triggerKind: 'invoked', isRetrigger: false, activeParameter: 0}]) assert.throws(() => parseLanguageRequest({...request, context}), hasCode('invalid_contract'));
  assert.throws(() => parseLanguageRequest({...request, position: {line: 0, character: 5}}), hasCode('invalid_contract'));
});

test('resolve binds the selected insertion and prepares a pure CRLF/Unicode edit with shifted tabstops', async t => {
  const {host, request} = await fixture(t, {resolve: (_request, selected) => ({...selected, detail: 'Two numbers', additionalTextEdits: [{range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}, text: '// header\r\n'}]})});
  const list = await request(); assert.equal(list.data[0].resolveData, undefined); assert.match(list.data[0].resolveToken, /^[a-f0-9-]{36}$/);
  const resolved = await host.resolveCompletion(list.data[0].resolveToken);
  assert.equal(resolved.data[0].resolveToken, undefined); assert.equal(resolved.data[0].resolveData, undefined);
  const preview = host.prepareCompletion(resolved);
  assert.equal(preview.content, '// header\r\nlet 😀 = 1;\r\nsum(left, right)');
  assert.deepEqual(preview.tabstops[0].ranges, [{start: {line: 2, character: 4}, end: {line: 2, character: 8}}]);
  assert.equal(preview.snapshot.modelVersion, 1); assert.equal(snapshot.text, 'let 😀 = 1;\r\nsu');
  await assert.rejects(host.resolveCompletion(list.data[0].resolveToken), hasCode('stale_snapshot'));
  assert.throws(() => host.prepareCompletion(structuredClone(resolved)), hasCode('stale_snapshot'));
  host.releaseCompletion(resolved); assert.throws(() => host.prepareCompletion(resolved), hasCode('stale_snapshot'));
});

test('resolve rejects changed insertion, executable fields, overlap and range outside the document', async t => {
  for (const mutate of [selected => ({...selected, insertText: 'changed'}), selected => ({...selected, range: {start: position, end: position}}), selected => ({...selected, command: 'run'}), selected => ({...selected, additionalTextEdits: [{range, text: 'overlap'}]}), selected => ({...selected, additionalTextEdits: [{range: {start: {line: 9, character: 0}, end: {line: 9, character: 0}}, text: 'outside'}]})]) {
    const {host, request} = await fixture(t, {resolve: (_request, selected) => mutate(selected)});
    await assert.rejects(host.resolveCompletion((await request()).data[0].resolveToken), hasCode('invalid_contract')); host.dispose();
  }
});

test('stale token and preview cannot cross hosts, document replacement, unregister or deactivation', async t => {
  for (const action of ['edit', 'restore', 'unregister', 'deactivate', 'dispose', 'release']) {
    const {host, registration, request} = await fixture(t); const list = await request(), token = list.data[0].resolveToken;
    const other = createPluginHost({grants: ['document.read', 'language.provide']}); t.after(() => other.dispose());
    await assert.rejects(other.resolveCompletion(token), hasCode('stale_snapshot'));
    if (action === 'edit' || action === 'restore') {host.setDocument({...snapshot, modelVersion: 2, text: 'new'}); if (action === 'restore') host.setDocument({...snapshot, modelVersion: 3});}
    if (action === 'unregister') registration.dispose();
    if (action === 'deactivate') host.deactivate(manifest.id);
    if (action === 'dispose') host.dispose();
    if (action === 'release') host.releaseCompletion(list);
    await assert.rejects(host.resolveCompletion(token), hasCode(action === 'dispose' ? 'disposed' : 'stale_snapshot'));
    assert.throws(() => host.prepareCompletion(list), error => ['disposed', 'stale_snapshot'].includes(error.code));
  }
});

test('tokens expire and released completion lists return bounded retention capacity', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const {host, request} = await fixture(t, {provide: req => createLanguageResult(req, Array.from({length: LANGUAGE_LIMITS.resolveTokens}, (_, n) => ({label: 'item-' + n, insertText: '', resolveData: {n}})))});
  const first = await request(); await assert.rejects(request(), hasCode('budget_exceeded'));
  host.releaseCompletion(first); const second = await request();
  now += LANGUAGE_LIMITS.resolveTtlMs; await assert.rejects(host.resolveCompletion(second.data[0].resolveToken), hasCode('stale_snapshot'));
  assert.equal((await request()).data.length, LANGUAGE_LIMITS.resolveTokens);
});

test('ignored resolve cancellation retains real provider slots until settlement and discards late data', async t => {
  const finish = deferred(), starts = []; let calls = 0;
  const {host, request} = await fixture(t, {resolve: async (_req, selected, {signal}) => {calls++; starts.push(signal); await finish.promise; return selected;}});
  try {
    for (let n = 0; n < LANGUAGE_LIMITS.resolvePending; n++) await assert.rejects(host.resolveCompletion((await request()).data[0].resolveToken, {timeoutMs: 5}), hasCode('budget_exceeded'));
    assert.equal(calls, 4); assert.ok(starts.every(signal => signal.aborted));
    await assert.rejects(host.resolveCompletion((await request()).data[0].resolveToken), hasCode('budget_exceeded'));
    assert.equal(calls, 4);
  } finally {finish.resolve();}
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await host.resolveCompletion((await request()).data[0].resolveToken)).data[0].label, 'sum');
});

test('capabilities and grants are explicit; old literal completions and provider classes remain supported', async t => {
  assert.throws(() => parseManifest({...manifest, capabilities: ['completion-resolve']}), hasCode('invalid_contract'));
  await assert.rejects(fixture(t, {capabilities: ['completion']}), hasCode('permission_denied'));
  const noSnippet = await fixture(t, {capabilities: ['completion', 'completion-resolve']});
  await assert.rejects(noSnippet.request(), hasCode('permission_denied'));
  const literal = await fixture(t, {resolve: null, capabilities: ['completion'], provide: request => createLanguageResult(request, [{label: 'literal', insertText: '$NAME <b>text</b>'}])});
  assert.equal(literal.host.prepareCompletion(await literal.request()).content, snapshot.text + '$NAME <b>text</b>');
  assert.deepEqual(literal.host.prepareCompletion(await literal.request()).tabstops, []);
  assert.equal(parseCompletionItem({label: '😀'.repeat(256), insertText: '😀'.repeat(16_384)}).insertText.length, 32_768);
  class Provider {provide(request) {return createLanguageResult(request, {text: 'class'});}}
  const registry = createLanguageRegistry('hover'); t.after(() => registry.dispose()); registry.register('class', {languages: ['dds-demo']}, new Provider());
  const req = {protocolVersion: 1, requestId: 'class', scope: {projectId: 'p', sessionId: 's'}, snapshot, position, kind: 'hover'};
  assert.equal((await registry.request(req)).data.text, 'class');
});

test('data validators do not execute getters and final insertion size is bounded', async t => {
  let accessed = false;
  assert.throws(() => parseCompletionItem({label: 'bad', get insertText() {accessed = true; return '';}}), hasCode('invalid_contract')); assert.equal(accessed, false);
  const {host} = await fixture(t, {resolve: null, capabilities: ['completion'], provide: request => createLanguageResult(request, [{label: 'grow', insertText: 'x'}])});
  host.setDocument({...snapshot, modelVersion: 2, text: 'a'.repeat(LIMITS.documentBytes)});
  await assert.rejects(host.requestLanguage('completion', {position: {line: 0, character: LIMITS.documentBytes}}), hasCode('provider_failed'));
});

test('signature requests and resolver results are discarded after cancellation or a document change', async t => {
  const finish = deferred(), started = deferred();
  const {host, request} = await fixture(t, {resolve: async (_request, selected) => {started.resolve(); await finish.promise; return selected;}});
  assert.deepEqual((await host.requestLanguage('signature-help', {position, context: {triggerKind: 'character', triggerCharacter: ',', isRetrigger: true, activeParameter: 0}})).data, signature);
  const token = (await request()).data[0].resolveToken;
  const pending = host.resolveCompletion(token); const rejected = assert.rejects(pending, hasCode('stale_snapshot'));
  await started.promise;
  host.setDocument({...snapshot, modelVersion: 2, text: snapshot.text + 'm'});
  await rejected; finish.resolve();
  const registry = createLanguageRegistry('signature-help'); t.after(() => registry.dispose());
  const blocked = deferred(); registry.register('slow', {languages: ['dds-demo']}, {provide: async req => {await blocked.promise; return createLanguageResult(req, signature);}});
  const controller = new AbortController();
  const result = registry.request({protocolVersion: 1, requestId: 'signature', scope: {projectId: 'p', sessionId: 's'}, snapshot, position, kind: 'signature-help'}, {signal: controller.signal});
  const cancelled = assert.rejects(result, hasCode('cancelled'));
  await Promise.resolve(); controller.abort(); await cancelled; blocked.resolve();
});

test('ordinary language requests that ignore cancellation retain the real concurrency budget', async t => {
  const registry = createLanguageRegistry('hover'); t.after(() => registry.dispose());
  const finish = deferred(), ready = deferred(); let calls = 0;
  registry.register('slow', {languages: ['dds-demo']}, {provide: async req => {if (++calls === LIMITS.maxPendingRequests) ready.resolve(); await finish.promise; return createLanguageResult(req, {text: 'late'});}});
  const req = {protocolVersion: 1, requestId: 'pending', scope: {projectId: 'p', sessionId: 's'}, snapshot, position, kind: 'hover'};
  const controllers = Array.from({length: LIMITS.maxPendingRequests}, () => new AbortController());
  const rejected = controllers.map(controller => assert.rejects(registry.request(req, {signal: controller.signal}), hasCode('cancelled')));
  try {
    await ready.promise; controllers.forEach(controller => controller.abort()); await Promise.all(rejected);
    await assert.rejects(registry.request(req), hasCode('budget_exceeded'));
    assert.equal(calls, LIMITS.maxPendingRequests);
  } finally {finish.resolve();}
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await registry.request(req)).data.text, 'late');
});

test('tokens retain the original provider, enforce memory budget and cannot be supplied by a provider', async t => {
  const registry = createLanguageRegistry('completion'); t.after(() => registry.dispose());
  const req = {protocolVersion: 1, requestId: 'select', scope: {projectId: 'p', sessionId: 's'}, snapshot, position, kind: 'completion'};
  registry.register('first', {languages: ['dds-demo']}, {provide: r => createLanguageResult(r, [item]), resolve: (_r, i) => ({...i, detail: 'original'})}, {resolve: true, snippets: true});
  const selected = await registry.request(req);
  registry.register('higher', {languages: ['dds-demo'], priority: 1}, {provide: r => createLanguageResult(r, [{label: 'other', insertText: ''}])});
  assert.equal((await registry.resolve(selected.data[0].resolveToken)).data[0].detail, 'original');
  const forged = await fixture(t, {provide: r => createLanguageResult(r, [{label: 'forged', insertText: '', resolveToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}])});
  await assert.rejects(forged.request(), hasCode('invalid_contract'));
  const memory = await fixture(t, {provide: r => createLanguageResult(r, Array.from({length: 20}, () => ({label: 'retain', insertText: '', resolveData: 1})))});
  memory.host.setDocument({...snapshot, modelVersion: 2, text: 'x'.repeat(220_000)});
  await assert.rejects(memory.host.requestLanguage('completion', {position: {line: 0, character: 0}}), hasCode('budget_exceeded'));
  assert.equal(SDK_VERSION, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
});
