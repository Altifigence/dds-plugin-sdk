import { createDiagnosticsResult, definePlugin, type Diagnostic, type PluginManifest } from '@altifigence/dds-plugin-sdk';
import { createTestHost } from '@altifigence/dds-plugin-sdk/testing';
import { SCHEMAS } from '@altifigence/dds-plugin-sdk/schemas';

const manifest: PluginManifest = {
  manifestVersion: 1, id: 'typed-plugin', name: 'Typed Plugin', publisher: 'example', version: '0.1.0',
  protocolVersion: 1, entry: './plugin.mjs', capabilities: ['diagnostics'],
  permissions: ['document.read', 'diagnostics.publish'], supportedHosts: ['test-host'], license: 'Apache-2.0',
};
const plugin = definePlugin(manifest, context => context.registerDiagnosticsProvider({languages: ['plaintext']}, {
  provideDiagnostics(request, {signal}) {
    signal.throwIfAborted();
    const diagnostics: Diagnostic[] = [];
    // @ts-expect-error diagnostics use a finite severity vocabulary
    diagnostics.push({severity: 'fatal', message: 'wrong', range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}}});
    // @ts-expect-error host input is immutable
    request.snapshot.text = 'mutated';
    return createDiagnosticsResult(request, diagnostics);
  },
}));
const host = createTestHost({grants: ['document.read', 'diagnostics.publish']});
await host.activate(plugin);
host.setDocument({uri: 'memory:///example.txt', languageId: 'plaintext', modelVersion: 1, workspaceRevision: 'one', text: 'hello'});
const result = await host.requestDiagnostics({signal: new AbortController().signal, timeoutMs: 10});
result.diagnostics.forEach(diagnostic => console.log(diagnostic.message));
host.dispose();
void SCHEMAS.manifest;
// @ts-expect-error shell permission is not available
createTestHost({grants: ['shell.execute']});
