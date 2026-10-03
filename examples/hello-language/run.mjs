import assert from 'node:assert/strict';
import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import plugin from './plugin.mjs';

const host = createPluginHost({grants: ['document.read', 'language.provide']});
try {
  await host.activate(plugin);
  host.setDocument({uri: 'memory:///demo.dds', languageId: 'dds-demo', modelVersion: 1, workspaceRevision: 'demo-1', text: 'let led = 1;\nled'});
  const input = {position: {line: 1, character: 1}};
  assert.equal((await host.requestLanguage('completion', input)).data[0].label, 'led');
  assert.equal((await host.requestLanguage('hover', input)).data.text, 'Local name: led');
  assert.equal((await host.requestLanguage('definition', input)).data[0].range.start.line, 0);
  assert.equal((await host.requestLanguage('references', {...input, includeDeclaration: true})).data.length, 2);
  assert.equal((await host.requestLanguage('document-symbols', {})).data[0].name, 'led');
  console.log('Hello Language: completion, hover, definition, references and document symbols verified');
} finally { host.dispose(); }
