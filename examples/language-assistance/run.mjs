import assert from 'node:assert/strict';
import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import plugin from './plugin.mjs';

const host = createPluginHost({grants: ['document.read', 'language.provide']});
try {
  await host.activate(plugin);
  const nested = 'sum(scale(2, 3), )';
  host.setDocument({uri: 'memory:///teaching.dds', languageId: 'teaching', modelVersion: 1, workspaceRevision: 'demo', text: nested});
  const inner = await host.requestLanguage('signature-help', {position: {line: 0, character: nested.indexOf('3')}, context: {triggerKind: 'invoked', isRetrigger: false}});
  assert.equal(inner.data.signatures[0].label, 'scale(left, right)');
  assert.equal(inner.data.activeParameter, 1);
  const outer = await host.requestLanguage('signature-help', {position: {line: 0, character: nested.length - 1}});
  assert.equal(outer.data.signatures[0].label, 'sum(left, right)');
  assert.equal(outer.data.signatures.length, 2);
  assert.equal(outer.data.activeParameter, 1);
  host.setDocument({uri: 'memory:///teaching.dds', languageId: 'teaching', modelVersion: 2, workspaceRevision: 'demo', text: '// 😀\r\nsu'});
  const selected = await host.requestLanguage('completion', {position: {line: 1, character: 2}});
  assert.equal(selected.data[0].resolveData, undefined);
  const detailed = await host.resolveCompletion(selected.data[0].resolveToken);
  assert.ok(detailed.data[0].documentation);
  const preview = host.prepareCompletion(detailed);
  assert.equal(preview.content, '// 😀\r\nsum(left, right)');
  assert.deepEqual(preview.tabstops.map(stop => stop.index), [1, 2, 0]);
  assert.deepEqual(preview.tabstops[0].ranges[0], {start: {line: 1, character: 4}, end: {line: 1, character: 8}});
  // A host UI can display this preview; no document or file is changed by these calls.
  host.releaseCompletion(selected); host.releaseCompletion(detailed);
  console.log('nested signature help, lazy completion resolution and Unicode snippet preview verified');
} finally {host.dispose();}
