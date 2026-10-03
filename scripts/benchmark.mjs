import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createPluginHost, parseDiagnosticsRequest } from '../src/index.mjs';
import { createTestHost } from '../src/testing.mjs';
import plugin from '../examples/hello-diagnostics/plugin.mjs';
import languagePlugin from '../examples/hello-language/plugin.mjs';
import {applyTextEdits} from '../src/workspace-project.mjs';

const entry = new URL('../src/index.mjs', import.meta.url).href;
const cold = [];
for (let i = 0; i < 5; i++) {
  const program = `const t=performance.now(); const before=process.memoryUsage().heapUsed; await import(${JSON.stringify(entry)}); console.log(JSON.stringify({ms:performance.now()-t,heapBytes:process.memoryUsage().heapUsed-before}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {encoding: 'utf8', timeout: 10_000});
  if (child.status !== 0) throw new Error(child.stderr || 'Cold import probe failed');
  cold.push(JSON.parse(child.stdout));
}
const text = 'Hello, DDS!\nTODO: write a plugin.\n'.repeat(100);
const request = {protocolVersion: 1, requestId: 'bench', scope: {projectId: 'p', sessionId: 's'}, snapshot: {uri: 'memory:///bench.txt', languageId: 'plaintext', modelVersion: 1, workspaceRevision: 'one', text}};
for (let i = 0; i < 1_000; i++) parseDiagnosticsRequest(request);
const iterations = 5_000;
const batches = [];
for (let batch = 0; batch < 10; batch++) {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) parseDiagnosticsRequest(request);
  batches.push((performance.now() - start) / iterations);
}
const host = createTestHost();
await host.activate(plugin);
host.setDocument(request.snapshot);
for (let i = 0; i < 100; i++) await host.requestDiagnostics();
const providerBatches = [];
for (let batch = 0; batch < 10; batch++) {
  const start = performance.now();
  for (let i = 0; i < 100; i++) await host.requestDiagnostics();
  providerBatches.push((performance.now() - start) / 100);
}
host.dispose();
const commandPlugin = (await import('../examples/publishable-plugin/plugin.mjs')).default;
const commands = createPluginHost({hostId: 'workspace-host'});
await commands.activate(commandPlugin);
for (let i = 0; i < 100; i++) await commands.executeCommand('hello-publisher', 'greet', {name: 'Ada'});
const commandBatches = [];
for (let batch = 0; batch < 10; batch++) {
  const start = performance.now();
  for (let i = 0; i < 100; i++) await commands.executeCommand('hello-publisher', 'greet', {name: 'Ada'});
  commandBatches.push((performance.now() - start) / 100);
}
commands.dispose();
const language = createPluginHost({grants: ['document.read', 'language.provide']});
await language.activate(languagePlugin);
language.setDocument({...request.snapshot, languageId: 'dds-demo', text: 'let led = 1;\nled'});
const languageBatches = [], editBatches = [];
for (let batch = 0; batch < 10; batch++) {
  const start = performance.now();
  for (let i = 0; i < 100; i++) await language.requestLanguage('completion', {position: {line: 1, character: 1}});
  languageBatches.push((performance.now() - start) / 100);
  const editStart = performance.now();
  for (let i = 0; i < 100; i++) applyTextEdits(text, [{range: {start: {line: 0, character: 0}, end: {line: 0, character: 5}}, text: 'Updated'}]);
  editBatches.push((performance.now() - editStart) / 100);
}
language.dispose();
const files = ['index.mjs', 'limits.mjs', 'patterns.mjs', 'contracts.mjs', 'lifecycle.mjs', 'host.mjs'];
const runtime = Buffer.concat(await Promise.all(files.map(name => readFile(new URL(`../src/${name}`, import.meta.url)))));
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({
  packageVersion, node: process.version, platform: `${process.platform}-${process.arch}`,
  inputUtf8Bytes: Buffer.byteLength(text), diagnosticsPerResult: 100,
  coreRuntimeBytes: runtime.length, coreRuntimeGzipBytes: gzipSync(runtime).length,
  coldImport: {samples: cold.length, medianMs: median(cold.map(value => value.ms)), medianHeapDeltaBytes: median(cold.map(value => value.heapBytes))},
  validation: {batchCount: batches.length, iterationsPerBatch: iterations, medianMsPerCall: median(batches)},
  localProviderRoundTrip: {batchCount: providerBatches.length, iterationsPerBatch: 100, medianMsPerCall: median(providerBatches)},
  localCommandRoundTrip: {batchCount: commandBatches.length, iterationsPerBatch: 100, medianMsPerCall: median(commandBatches)},
  localCompletionRoundTrip: {batchCount: languageBatches.length, iterationsPerBatch: 100, medianMsPerCall: median(languageBatches)},
  localTextEdit: {batchCount: editBatches.length, iterationsPerBatch: 100, medianMsPerCall: median(editBatches)},
  note: 'Synthetic local measurements; excludes process startup, DDS host integration, isolation, transport and UI. No latency guarantee.',
}, null, 2));
