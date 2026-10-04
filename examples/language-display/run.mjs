import assert from 'node:assert/strict';
import {createPluginHost, decodeSemanticTokens} from '@altifigence/dds-plugin-sdk';
import {createTeachingDisplayPlugin, sample, literalHint} from './plugin.mjs';
const host = createPluginHost({grants: ['document.read', 'language.provide']}), counters = {full: 0, delta: 0};
try {
  const plugin = createTeachingDisplayPlugin(counters), activation = await host.activate(plugin);
  const document = {uri: 'memory:///counter', languageId: 'teaching', modelVersion: 1, workspaceRevision: 'one', text: sample}; host.setDocument(document);
  const full = await host.requestLanguage('semantic-tokens', {}); assert.equal(full.data.updateKind, 'full');
  assert.ok(decodeSemanticTokens(host.validateLanguageResult(full).data, sample).some(token => token.style === 'string'));
  const [folds, hints, tree] = await Promise.all([host.requestLanguage('folding-ranges', {}), host.requestLanguage('inlay-hints', {range: {start: {line: 0, character: 0}, end: {line: 4, character: 0}}}), host.requestLanguage('document-symbol-tree', {})]);
  assert.equal(folds.data.length, 1); assert.equal(hints.data[1].label, literalHint); assert.equal(tree.data[0].children.length, 2);
  host.setDocument({...document, modelVersion: 2, text: sample.replace('12', '12345')});
  assert.throws(() => host.validateLanguageResult(full), error => error.code === 'stale_snapshot');
  const delta = await host.requestLanguage('semantic-tokens', {previousResultId: full.data.resultId}); assert.equal(delta.data.updateKind, 'delta');
  host.releaseLanguageResult(delta);
  const fallback = await host.requestLanguage('semantic-tokens', {previousResultId: delta.data.resultId}); assert.equal(fallback.data.updateKind, 'fallback');
  assert.deepEqual(counters, {full: 2, delta: 1}); activation.dispose();
  assert.throws(() => host.validateLanguageResult(fallback), error => error.code === 'disposed');
  await host.activate(plugin); assert.equal((await host.requestLanguage('semantic-tokens', {previousResultId: fallback.data.resultId})).data.updateKind, 'fallback');
  console.log('Language display: full, delta, lost-base fallback, folds, literal hints, symbol tree and stale disposal verified');
} finally {host.dispose(); host.dispose();}
