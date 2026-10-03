import { createTestHost } from '@altifigence/dds-plugin-sdk/testing';
import plugin from './plugin.mjs';

const host = createTestHost();
try {
  await host.activate(plugin);
  host.setDocument({
    uri: 'memory:///hello.txt',
    languageId: 'plaintext',
    modelVersion: 1,
    workspaceRevision: 'example-1',
    text: 'Hello, DDS!\nTODO: write a plugin.\n',
  });
  const result = await host.requestDiagnostics();
  console.log(`${plugin.manifest.name}: ${result.diagnostics.length} diagnostic`);
  for (const diagnostic of result.diagnostics) {
    console.log(`${diagnostic.severity} ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`);
  }
} finally {
  host.dispose();
}
