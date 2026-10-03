import { definePlugin, createDiagnosticsResult } from '../src/index.mjs';

export const manifest = {
  manifestVersion: 1, id: 'test-plugin', name: 'Test Plugin', publisher: 'example', version: '0.1.0',
  protocolVersion: 1, entry: './plugin.mjs', capabilities: ['diagnostics'],
  permissions: ['document.read', 'diagnostics.publish'], supportedHosts: ['test-host'], license: 'Apache-2.0',
};
export const document = {uri: 'memory:///test.txt', languageId: 'plaintext', modelVersion: 1, workspaceRevision: 'rev-1', text: 'hello\nTODO\n'};
export const request = {protocolVersion: 1, requestId: 'test-request', scope: {projectId: 'p', sessionId: 's'}, snapshot: document};
export const diagnostic = {range: {start: {line: 1, character: 0}, end: {line: 1, character: 4}}, severity: 'info', message: 'Resolve TODO'};
export const clone = value => structuredClone(value);
export const hasCode = code => error => error?.code === code;
export function makePlugin(provideDiagnostics = request => createDiagnosticsResult(request, []), options = {}) {
  return definePlugin({...manifest, ...options}, context => context.registerDiagnosticsProvider({languages: ['plaintext']}, {provideDiagnostics}));
}
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
