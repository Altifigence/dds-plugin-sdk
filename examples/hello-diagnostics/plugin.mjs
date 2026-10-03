import { createDiagnosticsResult, definePlugin } from '@altifigence/dds-plugin-sdk';

export default definePlugin({
  manifestVersion: 1,
  id: 'hello-diagnostics',
  name: 'Hello Diagnostics',
  publisher: 'example',
  version: '0.1.0',
  protocolVersion: 1,
  entry: './plugin.mjs',
  capabilities: ['diagnostics'],
  permissions: ['document.read', 'diagnostics.publish'],
  supportedHosts: ['test-host'],
  license: 'Apache-2.0',
}, context => context.registerDiagnosticsProvider({languages: ['plaintext']}, {
  provideDiagnostics(request, {signal}) {
    signal.throwIfAborted();
    const diagnostics = [];
    const lines = request.snapshot.text.split(/\r\n|\n|\r/);
    for (let line = 0; line < lines.length; line++) {
      const character = lines[line].indexOf('TODO');
      if (character !== -1) diagnostics.push({
        range: {start: {line, character}, end: {line, character: character + 4}},
        severity: 'info',
        code: 'todo',
        source: 'hello-diagnostics',
        message: 'Resolve this TODO before sharing the document.',
      });
    }
    return createDiagnosticsResult(request, diagnostics);
  },
}));
