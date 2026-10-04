import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPluginHost, createLanguageRegistry, definePlugin, createLanguageResult, parseLanguageRequest, parseManifest, parseSemanticLegend, parseSemanticTokens, parseSemanticTokensDelta, decodeSemanticTokens, applySemanticTokensDelta, parseFoldingRanges, parseInlayHints, parseDocumentSymbolTree, LANGUAGE_DISPLAY_LIMITS, LIMITS} from '../src/index.mjs';
import {hasCode, deferred} from './fixtures.mjs';

const snapshot = {uri: 'memory:///demo', languageId: 'teaching', modelVersion: 1, workspaceRevision: 'one', text: 'let 😀 = 12;\r\nvalue'};
const legend = {tokenTypes: [{name: 'keyword', style: 'keyword'}, {name: 'value', style: 'variable'}], tokenModifiers: ['readonly']};
const data = {resultId: 'provider-1', legend, data: [0, 0, 3, 0, 0, 0, 4, 2, 1, 1, 1, 0, 5, 1, 0]};
const scope = {projectId: 'project', sessionId: 'session'};
const request = (kind = 'semantic-tokens', input = {}, doc = snapshot) => ({protocolVersion: 1, requestId: 'display', scope, snapshot: doc, kind, ...input});
const range = (start, end, line = 0) => ({start: {line, character: start}, end: {line, character: end}});
const manifest = {manifestVersion: 2, id: 'display', name: 'Display', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', capabilities: ['semantic-tokens', 'semantic-tokens-delta'], permissions: ['document.read', 'language.provide'], supportedHosts: ['test-host'], license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'}};
async function fixture(t, {provide, provideDelta, capabilities = manifest.capabilities} = {}) {
  const calls = {full: 0, delta: 0}; const host = createPluginHost({scope, grants: manifest.permissions}); t.after(() => host.dispose());
  let registration;
  const plugin = definePlugin({...manifest, capabilities}, context => {
    registration = context.registerLanguageProvider('semantic-tokens', {languages: ['teaching']}, {
      provide(r, options) {calls.full++; assert.equal(r.previousResultId, undefined); return provide ? provide(r, options) : createLanguageResult(r, data);},
      ...(capabilities.includes('semantic-tokens-delta') ? {provideDelta(r, previous, options) {calls.delta++; assert.equal(r.previousResultId, undefined); assert.equal(previous.snapshot.text, undefined); assert.ok(Object.isFrozen(previous.data)); return provideDelta ? provideDelta(r, previous, options) : {baseResultId: previous.resultId, resultId: 'provider-2', edits: []};}} : {}),
    });
  });
  const activation = await host.activate(plugin); host.setDocument(snapshot);
  return {host, calls, registration, activation, plugin, request: previous => host.requestLanguage('semantic-tokens', previous ? {previousResultId: previous} : {})};
}

test('semantic decoding validates UTF-16, CRLF, legends, ordering and immutable bounded arrays', () => {
  const decoded = decodeSemanticTokens(data, snapshot.text);
  assert.deepEqual(decoded[1], {range: range(4, 6), type: 'value', style: 'variable', modifiers: ['readonly']});
  assert.deepEqual(decoded[2].range, range(0, 5, 1)); assert.ok(Object.isFrozen(decoded));
  for (const numbers of [[0, 0, 0, 0, 0], [0, 5, 1, 1, 0], [0, 4, 1, 1, 0], [0, 0, 3, 2, 0], [0, 0, 3, 0, 2], [0, 0, 3, 0, 0, 0, 2, 2, 1, 0], [2, 0, 1, 0, 0], [0, 0, 3], [-1, 0, 1, 0, 0], [0, 0, 1.5, 0, 0]]) assert.throws(() => decodeSemanticTokens({...data, data: numbers}, snapshot.text), hasCode('invalid_contract'));
  for (const invalid of [{...legend, tokenTypes: [{name: 'url(x)', style: 'keyword'}]}, {...legend, tokenTypes: [{name: 'x', style: 'url(javascript:run)'}]}, {...legend, tokenModifiers: ['a', 'a']}, {...legend, tokenTypes: [legend.tokenTypes[0], legend.tokenTypes[0]]}]) assert.throws(() => parseSemanticLegend(invalid), hasCode('invalid_contract'));
  const max = {resultId: 'max', legend, data: Array.from({length: LANGUAGE_DISPLAY_LIMITS.semanticTokens}, (_v, n) => [0, n === 0 ? 0 : 1, 1, 0, 0]).flat()};
  assert.equal(decodeSemanticTokens(max, 'x'.repeat(20000)).length, 20000);
  assert.throws(() => parseSemanticTokens({...max, data: [...max.data, 0, 1, 1, 0, 0]}), hasCode('budget_exceeded'));
});

test('semantic delta edits address original integer offsets and revalidate the whole result', () => {
  const delta = {baseResultId: data.resultId, resultId: 'new', edits: [{start: 2, deleteCount: 1, data: [2]}, {start: 14, deleteCount: 1, data: [1]}]};
  const next = applySemanticTokensDelta(data, delta, snapshot.text);
  assert.equal(next.data[2], 2); assert.equal(next.data[14], 1); assert.equal(data.data[2], 3);
  assert.throws(() => applySemanticTokensDelta(data, {...delta, baseResultId: 'wrong'}, snapshot.text), hasCode('stale_snapshot'));
  for (const edits of [[{start: 2, deleteCount: 2}, {start: 3, deleteCount: 0}], [{start: 0, deleteCount: 0}, {start: 0, deleteCount: 0}], [{start: 0, deleteCount: 0, data: [0.5]}]]) assert.throws(() => parseSemanticTokensDelta({...delta, edits}), hasCode('invalid_contract'));
  for (const edits of [[{start: 16, deleteCount: 0}], [{start: 2, deleteCount: 1}], [{start: 2, deleteCount: 1, data: [100]}]]) assert.throws(() => applySemanticTokensDelta(data, {...delta, edits}, snapshot.text), hasCode('invalid_contract'));
});

test('full and delta return host handles, preserve edit bases and discard stale paint', async t => {
  const {host, request: get, calls} = await fixture(t);
  const first = await get(); assert.equal(first.data.updateKind, 'full'); assert.notEqual(first.data.resultId, data.resultId);
  assert.equal(host.validateLanguageResult(first), first);
  assert.throws(() => host.validateLanguageResult(structuredClone(first)), hasCode('stale_snapshot'));
  host.setDocument({...snapshot, modelVersion: 2, workspaceRevision: 'two', text: snapshot.text + '!'});
  assert.throws(() => host.validateLanguageResult(first), hasCode('stale_snapshot'));
  const next = await get(first.data.resultId); assert.equal(next.data.updateKind, 'delta'); assert.deepEqual(calls, {full: 1, delta: 1});
  host.releaseLanguageResult(next); assert.throws(() => host.validateLanguageResult(next), hasCode('stale_snapshot'));
  assert.equal((await get(next.data.resultId)).data.updateKind, 'fallback'); assert.equal(calls.full, 2);
});

test('unknown, expired, evicted and reset semantic bases make one full fallback', async t => {
  const {host, request: get, calls} = await fixture(t);
  const first = await get();
  for (let n = 0; n < LANGUAGE_DISPLAY_LIMITS.semanticCacheEntries; n++) await get();
  const before = calls.full; assert.equal((await get(first.data.resultId)).data.updateKind, 'fallback'); assert.equal(calls.full, before + 1); assert.equal(calls.delta, 0);
  const newest = await get(); const realNow = Date.now; Date.now = () => realNow() + LANGUAGE_DISPLAY_LIMITS.semanticCacheTtlMs + 1;
  try {assert.equal((await get(newest.data.resultId)).data.updateKind, 'fallback');} finally {Date.now = realNow;}
  const reset = await get(); host.setDocument({...snapshot, workspaceRevision: 'replacement'});
  assert.equal((await get(reset.data.resultId)).data.updateKind, 'fallback');
  assert.equal((await get(randomUUID())).data.updateKind, 'fallback');
});

test('provider null or base mismatch falls back once; malformed deltas and provider errors do not', async t => {
  for (const answer of [null, {baseResultId: 'unavailable', resultId: 'new', edits: []}]) {
    const {request: get, calls} = await fixture(t, {provideDelta: () => answer}); const first = await get();
    assert.equal((await get(first.data.resultId)).data.updateKind, 'fallback'); assert.deepEqual(calls, {full: 2, delta: 1});
  }
  for (const [answer, code] of [[{baseResultId: 'provider-1', resultId: 'new', edits: [{start: 2, deleteCount: 1, data: [999]}]}, 'invalid_contract'], [undefined, 'invalid_contract']]) {
    const {request: get, calls} = await fixture(t, {provideDelta: () => answer}); const first = await get();
    await assert.rejects(get(first.data.resultId), hasCode(code)); assert.deepEqual(calls, {full: 1, delta: 1});
  }
  const {request: get, calls} = await fixture(t, {provideDelta: () => {throw new Error('private provider detail');}}); const first = await get();
  await assert.rejects(get(first.data.resultId), error => error.code === 'provider_failed' && !error.message.includes('private')); assert.equal(calls.full, 1);
});

test('delta provider registration requires the declared feature and modifier', async t => {
  assert.throws(() => parseManifest({...manifest, capabilities: ['semantic-tokens-delta']}), hasCode('invalid_contract'));
  const registry = createLanguageRegistry('semantic-tokens'); t.after(() => registry.dispose());
  const provide = r => createLanguageResult(r, data);
  assert.throws(() => registry.register('example', {languages: ['teaching']}, {provide, provideDelta: () => null}), hasCode('permission_denied'));
  assert.throws(() => registry.register('example', {languages: ['teaching']}, {provide}, {semanticDelta: true}), hasCode('permission_denied'));
  const {request: get, calls} = await fixture(t, {capabilities: ['semantic-tokens']}); const first = await get();
  assert.equal((await get(first.data.resultId)).data.updateKind, 'fallback'); assert.deepEqual(calls, {full: 2, delta: 0});
});

test('provider changes, deactivation and disposal cannot reuse previous provider data', async t => {
  const {host, plugin, activation, request: get, calls} = await fixture(t); const first = await get();
  activation.dispose(); assert.throws(() => host.validateLanguageResult(first), hasCode('disposed'));
  await host.activate(plugin); assert.equal((await get(first.data.resultId)).data.updateKind, 'fallback'); assert.equal(calls.delta, 0);
  host.dispose(); host.dispose(); await assert.rejects(get(), hasCode('disposed'));
  const registry = createLanguageRegistry('semantic-tokens'); t.after(() => registry.dispose());
  const a = registry.register('a', {languages: ['teaching']}, {provide: r => createLanguageResult(r, data), provideDelta: () => {throw Error('wrong provider');}}, {semanticDelta: true});
  const base = await registry.request(request());
  registry.register('b', {languages: ['teaching'], priority: 10}, {provide: r => createLanguageResult(r, {...data, resultId: 'b'})});
  assert.equal((await registry.request(request('semantic-tokens', {previousResultId: base.data.resultId}))).data.updateKind, 'fallback');
  a.dispose();
});

test('pending semantic work honors document changes, cancellation and actual live operation slots', async t => {
  const waits = [], started = deferred(); const registry = createLanguageRegistry('semantic-tokens'); t.after(() => registry.dispose());
  registry.register('slow', {languages: ['teaching']}, {provide(r) {const wait = deferred(); waits.push({wait, r}); started.resolve(); return wait.promise;}});
  const operations = Array.from({length: LIMITS.maxPendingRequests}, () => registry.request(request(), {timeoutMs: 5}));
  await started.promise; await Promise.all(operations.map(p => assert.rejects(p, hasCode('budget_exceeded'))));
  await assert.rejects(registry.request(request()), hasCode('budget_exceeded'));
  for (const {wait, r} of waits) wait.resolve(createLanguageResult(r, data));
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController(); const cancelled = registry.request(request(), {signal: controller.signal});
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await assert.rejects(cancelled, hasCode('cancelled'));
  const last = waits.at(-1); last.wait.resolve(createLanguageResult(last.r, data));
  const slow = deferred(), entered = deferred(); const {host, request: get} = await fixture(t, {provideDelta: () => {entered.resolve(); return slow.promise;}});
  const first = await get(), pending = get(first.data.resultId); await entered.promise;
  host.setDocument({...snapshot, modelVersion: 2}); await assert.rejects(pending, hasCode('stale_snapshot')); slow.resolve(null);
});

test('delta fallback shares the original timeout and never starts a third operation', async t => {
  let first = true, now = 0; const entered = deferred(), slow = deferred();
  const {host, request: get, calls} = await fixture(t, {
    provide: r => {if (first) {first = false; return createLanguageResult(r, data);} entered.resolve(r); return slow.promise;},
    provideDelta: () => {now += 60; return null;},
  });
  const base = await get();
  const timers = [], timer = globalThis.setTimeout, controller = new AbortController();
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {timers.push(delay); return timer(callback, delay, ...args);});
  const pending = host.requestLanguage('semantic-tokens', {previousResultId: base.data.resultId}, {timeoutMs: 100, signal: controller.signal});
  const r = await entered.promise; controller.abort(); await assert.rejects(pending, hasCode('cancelled'));
  assert.deepEqual(timers, [100, 40]); assert.deepEqual(calls, {full: 2, delta: 1}); slow.resolve(createLanguageResult(r, data));
});

test('folding ranges reject crossing, duplicate, unsorted, over-deep and out-of-document geometry', () => {
  assert.equal(parseFoldingRanges([{range: range(0, 10)}, {range: range(1, 5)}, {range: range(6, 9)}]).length, 3);
  for (const values of [[{range: range(0, 4)}, {range: range(2, 6)}], [{range: range(0, 4)}, {range: range(0, 4)}], [{range: range(2, 5)}, {range: range(0, 10)}], [{range: range(1, 1)}]]) assert.throws(() => parseFoldingRanges(values), hasCode('invalid_contract'));
  assert.throws(() => parseFoldingRanges(Array.from({length: 33}, (_v, n) => ({range: range(n, 100 - n)}))), hasCode('budget_exceeded'));
  assert.throws(() => createLanguageResult(request('folding-ranges'), [{range: range(0, 99)}]), hasCode('invalid_contract'));
});

test('inlay hints are literal bounded labels within the requested UTF-16 range', () => {
  const label = '<img src=x onerror=alert(1)>', hints = [{position: {line: 1, character: 2}, label, tooltip: '<a href=javascript:x>text</a>'}];
  assert.equal(createLanguageResult(request('inlay-hints', {range: range(0, 5, 1)}), hints).data[0].label, label);
  for (const value of [[{...hints[0], command: 'execute'}], [{...hints[0], label: 'x\ny'}], [{...hints[0], position: {line: 0, character: 5}}]]) assert.throws(() => createLanguageResult(request('inlay-hints', {range: range(0, 5, 1)}), value), hasCode('invalid_contract'));
  assert.throws(() => parseInlayHints(Array(1001).fill(hints[0])), hasCode('budget_exceeded'));
});

test('symbol trees enforce total size, contained children, selections, sibling order and depth', () => {
  const symbol = {name: 'top', kind: 'module', range: range(0, 10), selectionRange: range(0, 3)}, child = {...symbol, name: 'child', range: range(4, 6), selectionRange: range(4, 6)};
  assert.equal(parseDocumentSymbolTree([{...symbol, children: [child]}])[0].children.length, 1);
  for (const children of [null, {}, [{...child, range: range(4, 12)}], [child, child]]) assert.throws(() => parseDocumentSymbolTree([{...symbol, children}]), hasCode('invalid_contract'));
  let deep = child; for (let n = 0; n < 16; n++) deep = {...symbol, children: [deep]};
  assert.throws(() => parseDocumentSymbolTree([deep]), hasCode('budget_exceeded'));
  const siblings = Array.from({length: 1000}, (_v, n) => ({...child, range: range(n, n + 1), selectionRange: range(n, n + 1)}));
  assert.throws(() => parseDocumentSymbolTree([{...symbol, range: range(0, 1000), children: siblings}]), hasCode('budget_exceeded'));
  assert.throws(() => createLanguageResult(request('document-symbol-tree'), [{...symbol, range: range(0, 100)}]), hasCode('invalid_contract'));
});

test('display requests reject irrelevant fields and all displayed results require current host ownership', async t => {
  for (const invalid of [request('semantic-tokens', {position: {line: 0, character: 0}}), request('semantic-tokens', {previousResultId: 'provider-1'}), request('folding-ranges', {previousResultId: randomUUID()}), request('inlay-hints'), request('document-symbol-tree', {range: range(0, 1)})]) assert.throws(() => parseLanguageRequest(invalid), hasCode('invalid_contract'));
  const host = createPluginHost({grants: manifest.permissions}); t.after(() => host.dispose());
  await host.activate(definePlugin({...manifest, capabilities: ['folding-ranges', 'inlay-hints', 'document-symbol-tree']}, context => {
    for (const kind of ['folding-ranges', 'inlay-hints', 'document-symbol-tree']) context.registerLanguageProvider(kind, {languages: ['teaching']}, {provide: r => createLanguageResult(r, [])});
  })); host.setDocument(snapshot);
  const values = await Promise.all(['folding-ranges', 'inlay-hints', 'document-symbol-tree'].map(kind => host.requestLanguage(kind, kind === 'inlay-hints' ? {range: range(0, 3)} : {})));
  for (const value of values) assert.equal(host.validateLanguageResult(value), value);
  host.setDocument({...snapshot, modelVersion: 2});
  for (const value of values) assert.throws(() => host.validateLanguageResult(value), hasCode('stale_snapshot'));
});
