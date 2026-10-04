import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginHost, createLanguageResult, createDiagnosticsResult, definePlugin, parseManifest, parseLanguageRequest, parseCodeAction, parseFormattingOptions, LANGUAGE_LIMITS} from '../src/index.mjs';
import {editHash} from '../src/workspace-edit-contracts.mjs';
import {deferred, hasCode} from './fixtures.mjs';

const snapshot = {uri: 'memory:///main.dds', languageId: 'teaching', modelVersion: 1, workspaceRevision: 'one', text: 'x  \r\nTODO 😀'};
const range = {start: {line: 0, character: 0}, end: {line: 1, character: 7}};
const diagnostic = {range: {start: {line: 1, character: 0}, end: {line: 1, character: 4}}, severity: 'warning', message: 'Replace TODO'};
const trim = {range: {start: {line: 0, character: 1}, end: {line: 0, character: 3}}, text: ''};
const formatOptions = {tabSize: 2, insertSpaces: true, trimTrailingWhitespace: true};
const plan = (req, edits = [trim], path = req.path) => ({formatVersion: 1, id: crypto.randomUUID(), title: 'Proposed edit', changes: [{kind: 'edit', path, baseRevision: editHash(req.snapshot.text), edits}]});
const action = {title: 'Replace TODO', kind: 'quickfix', isPreferred: true, diagnosticIndices: [0], resolveData: {fix: 'todo'}};
const manifest = {manifestVersion: 2, id: 'editing', name: 'Editing', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', supportedHosts: ['test-host'], license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'}, capabilities: ['diagnostics', 'format-document', 'format-range', 'code-actions', 'code-action-resolve'], permissions: ['document.read', 'diagnostics.publish', 'language.provide']};
async function fixture(t, {format = req => createLanguageResult(req, plan(req)), provide = req => createLanguageResult(req, [action]), resolve = (req, item) => ({...item, edit: plan(req, [{range: diagnostic.range, text: 'DONE'}])}), diagnostics = req => createDiagnosticsResult(req, [diagnostic]), capabilities = manifest.capabilities} = {}) {
  const host = createPluginHost({grants: manifest.permissions}); t.after(() => host.dispose()); let diagnosticRegistration, actionRegistration;
  await host.activate(definePlugin({...manifest, capabilities}, context => {
    diagnosticRegistration = context.registerDiagnosticsProvider({languages: ['teaching']}, {provideDiagnostics: diagnostics});
    for (const kind of ['format-document', 'format-range']) context.registerLanguageProvider(kind, {languages: ['teaching']}, {provide: format});
    actionRegistration = context.registerLanguageProvider('code-actions', {languages: ['teaching']}, {provide, ...(resolve ? {resolve} : {})});
  }));
  host.setDocument(snapshot); await host.requestDiagnostics();
  return {host, diagnosticRegistration, actionRegistration, request: () => host.requestLanguage('code-actions', {path: 'main.dds', range})};
}

test('formatting validates options, current file scope, range and CRLF; pure no-ops become null', async t => {
  const {host} = await fixture(t);
  const result = await host.requestLanguage('format-document', {path: 'main.dds', formatOptions});
  assert.equal(host.prepareFormatting(result).changes[0].edits[0].text, '');
  assert.throws(() => host.prepareFormatting(structuredClone(result)), hasCode('stale_snapshot'));
  assert.equal((await host.requestLanguage('format-range', {path: 'main.dds', formatOptions, range: {start: range.start, end: {line: 0, character: 3}}})).data.changes.length, 1);
  const noop = await fixture(t, {format: req => createLanguageResult(req, plan(req, [{...trim, text: '  '}]))});
  assert.equal((await noop.host.requestLanguage('format-document', {path: 'main.dds', formatOptions})).data, null);
  assert.throws(() => parseFormattingOptions({...formatOptions, tabSize: 0}), hasCode('invalid_contract'));
  assert.throws(() => parseFormattingOptions({...formatOptions, command: 'execute'}), hasCode('invalid_contract'));
  const replacement = {range, text: 'x\nTODO 😀'};
  const lf = await fixture(t, {format: req => createLanguageResult(req, plan(req, [replacement]))});
  await assert.rejects(lf.host.requestLanguage('format-document', {path: 'main.dds', formatOptions}), hasCode('provider_failed'));
  assert.ok((await lf.host.requestLanguage('format-document', {path: 'main.dds', formatOptions: {...formatOptions, endOfLine: 'lf'}})).data);
  host.setDocument({...snapshot, modelVersion: 2, text: 'changed'});
  assert.throws(() => host.prepareFormatting(result), hasCode('stale_snapshot'));
});

test('formatters cannot edit outside the selected range, overlap edits, change paths or exceed file bounds', async t => {
  for (const format of [
    req => createLanguageResult(req, plan(req, [trim, trim])),
    req => createLanguageResult(req, plan(req, [{range: {start: {line: 1, character: 6}, end: {line: 1, character: 6}}, text: 'x'}])),
    req => createLanguageResult(req, plan(req, [trim], 'other.dds')),
    req => createLanguageResult(req, plan(req, [{...trim, text: 'x'.repeat(262_144)}])),
    req => createLanguageResult(req, {...plan(req), changes: [{...plan(req).changes[0], baseRevision: '0'.repeat(64)}]}),
  ]) {
    const {host} = await fixture(t, {format});
    await assert.rejects(host.requestLanguage('format-document', {path: 'main.dds', formatOptions}), hasCode('provider_failed'));
  }
  const {host} = await fixture(t);
  await assert.rejects(host.requestLanguage('format-range', {path: 'main.dds', formatOptions, range: diagnostic.range}), hasCode('provider_failed'));
});

test('actions bind the accepted diagnostic bundle and expose only explicit proposed edits', async t => {
  let context;
  const {host, request} = await fixture(t, {provide: req => {context = req.diagnosticContext; return createLanguageResult(req, [action]);}});
  const list = await request(); assert.deepEqual(context.diagnostics, [diagnostic]); assert.ok(context.revision > 0);
  assert.equal(list.data[0].resolveData, undefined); assert.ok(list.data[0].resolveToken);
  assert.throws(() => host.prepareCodeAction(list), hasCode('capability_unavailable'));
  const resolved = await host.resolveCodeAction(list.data[0].resolveToken);
  assert.equal(host.prepareCodeAction(resolved).changes[0].edits[0].text, 'DONE');
  await assert.rejects(host.resolveCodeAction(list.data[0].resolveToken), hasCode('stale_snapshot'));
  assert.throws(() => host.prepareCodeAction(structuredClone(resolved)), hasCode('stale_snapshot'));
  host.releaseCodeActions(resolved); assert.throws(() => host.prepareCodeAction(resolved), hasCode('stale_snapshot'));
  const disabled = await fixture(t, {provide: req => createLanguageResult(req, [{title: '<script>plain text</script>', kind: 'quickfix', disabled: {reason: 'No fix'}}])});
  const unavailable = await disabled.request(); assert.equal(unavailable.data[0].title, '<script>plain text</script>');
  assert.throws(() => disabled.host.prepareCodeAction(unavailable), hasCode('capability_unavailable'));
});

test('updating diagnostics invalidates retained and in-flight actions without changing the document', async t => {
  const finish = deferred(), started = deferred();
  const {host, request, diagnosticRegistration} = await fixture(t, {resolve: async (req, item) => {started.resolve(); await finish.promise; return {...item, edit: plan(req)};}});
  const old = await request(); const pending = host.resolveCodeAction(old.data[0].resolveToken), rejected = assert.rejects(pending, hasCode('stale_snapshot'));
  await started.promise; await host.requestDiagnostics(); await rejected; finish.resolve();
  assert.throws(() => host.prepareCodeAction(old), hasCode('stale_snapshot'));
  const newer = await request(); diagnosticRegistration.dispose();
  await assert.rejects(host.resolveCodeAction(newer.data[0].resolveToken), hasCode('stale_snapshot'));
});

test('out-of-order diagnostics do not replace the newer accepted action context', async t => {
  let calls = 0; const older = deferred(), started = deferred(); let observed;
  const {host, request} = await fixture(t, {diagnostics: async req => {
    const index = ++calls;
    if (index === 2) {started.resolve(); await older.promise;}
    return createDiagnosticsResult(req, [{...diagnostic, message: 'publication-' + index}]);
  }, provide: req => {observed = req.diagnosticContext; return createLanguageResult(req, [action]);}});
  const first = host.requestDiagnostics(); await started.promise;
  await host.requestDiagnostics(); const current = await request(); assert.equal(observed.diagnostics[0].message, 'publication-3');
  older.resolve(); await first;
  const result = await host.resolveCodeAction(current.data[0].resolveToken); assert.ok(result.data[0].edit);
  await request(); assert.equal(observed.diagnostics[0].message, 'publication-3');
});

test('action filters, immutable selection, diagnostic indices and executable fields are enforced', async t => {
  for (const value of [{...action, command: 'shell'}, {...action, url: 'https://example.invalid'}, {...action, disabled: {reason: 'No'}}, {...action, diagnosticIndices: [0, 0]}]) assert.throws(() => parseCodeAction(value), hasCode('invalid_contract'));
  const {host} = await fixture(t);
  await assert.rejects(host.requestLanguage('code-actions', {path: 'main.dds', range, context: {triggerKind: 'invoked', only: ['refactor']}}), hasCode('provider_failed'));
  const badIndex = await fixture(t, {provide: req => createLanguageResult(req, [{...action, diagnosticIndices: [1]}])});
  await assert.rejects(badIndex.request(), hasCode('provider_failed'));
  const changed = await fixture(t, {resolve: (req, item) => ({...item, title: 'Different choice', edit: plan(req)})});
  await assert.rejects(changed.host.resolveCodeAction((await changed.request()).data[0].resolveToken), hasCode('invalid_contract'));
  const foreign = await fixture(t); await assert.rejects(foreign.host.resolveCodeAction((await host.requestLanguage('code-actions', {path: 'main.dds', range})).data[0].resolveToken), hasCode('stale_snapshot'));
});

test('ignored action cancellation, provider disposal and document changes cannot revive old tokens', async t => {
  const finish = deferred(); let calls = 0;
  const {host, request, actionRegistration} = await fixture(t, {resolve: async (req, item) => {calls++; await finish.promise; return {...item, edit: plan(req)};}});
  try {
    for (let n = 0; n < LANGUAGE_LIMITS.resolvePending; n++) await assert.rejects(host.resolveCodeAction((await request()).data[0].resolveToken, {timeoutMs: 5}), hasCode('budget_exceeded'));
    await assert.rejects(host.resolveCodeAction((await request()).data[0].resolveToken), hasCode('budget_exceeded')); assert.equal(calls, 4);
  } finally {finish.resolve();}
  await new Promise(resolve => setImmediate(resolve));
  const result = await request(); actionRegistration.dispose();
  await assert.rejects(host.resolveCodeAction(result.data[0].resolveToken), hasCode('stale_snapshot'));
  const changed = await fixture(t), retained = await changed.request(); changed.host.setDocument({...snapshot, modelVersion: 2, text: snapshot.text + '!'});
  await assert.rejects(changed.host.resolveCodeAction(retained.data[0].resolveToken), hasCode('stale_snapshot'));
});

test('action resolve capability and request-only diagnostics cannot be forged through host input', async t => {
  assert.throws(() => parseManifest({...manifest, capabilities: ['code-action-resolve']}), hasCode('invalid_contract'));
  await assert.rejects(fixture(t, {capabilities: manifest.capabilities.filter(cap => cap !== 'code-action-resolve')}), hasCode('permission_denied'));
  const {host} = await fixture(t);
  await assert.rejects(host.requestLanguage('code-actions', {path: 'main.dds', range, diagnosticContext: {revision: 0, diagnostics: []}}), hasCode('invalid_contract'));
  const request = {protocolVersion: 1, requestId: 'test', scope: {projectId: 'p', sessionId: 's'}, snapshot, kind: 'format-document', path: 'main.dds', formatOptions};
  assert.throws(() => parseLanguageRequest({...request, range}), hasCode('invalid_contract'));
  assert.throws(() => parseLanguageRequest({...request, context: {triggerKind: 'invoked'}}), hasCode('invalid_contract'));
});

test('action counts, private resolve data and provider-supplied tokens obey their budgets', async t => {
  assert.throws(() => parseCodeAction({...action, resolveData: 'x'.repeat(4096)}), hasCode('budget_exceeded'));
  const oversized = await fixture(t, {provide: req => createLanguageResult(req, Array.from({length: 101}, () => action))});
  await assert.rejects(oversized.request(), hasCode('provider_failed'));
  const forged = await fixture(t, {provide: req => createLanguageResult(req, [{...action, resolveToken: crypto.randomUUID()}])});
  await assert.rejects(forged.request(), hasCode('invalid_contract'));
  const bounded = await fixture(t, {provide: req => createLanguageResult(req, Array.from({length: 100}, () => action))});
  const list = await bounded.request(); await assert.rejects(bounded.request(), hasCode('budget_exceeded'));
  bounded.host.releaseCodeActions(list); assert.equal((await bounded.request()).data.length, 100);
});
