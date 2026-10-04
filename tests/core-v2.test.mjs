import test from 'node:test';
import assert from 'node:assert/strict';
import { createPluginHost, definePlugin, ErrorCode, LIMITS, PluginSdkError, parseCommandDefinition, parseJsonValue, parseLicenseExpression, parseManifest, parseWorkspacePath } from '../src/index.mjs';
import { SCHEMAS } from '../src/schemas.mjs';
import { THEME_SCHEMA } from '../src/themes.mjs';
import { deferred, hasCode, manifest as v1Manifest } from './fixtures.mjs';

const manifest = {
  ...v1Manifest, manifestVersion: 2, id: 'workspace-example', capabilities: ['commands'],
  permissions: ['workspace.read', 'workspace.write', 'backend.invoke'], supportedHosts: ['test-host', 'workspace-host'],
  runtime: 'workspace', license: 'MIT OR LicenseRef-Example-Proprietary',
  source: {visibility: 'closed', licenseFile: 'LICENSE'},
};
const command = {id: 'hello', title: 'Hello', parameters: [{name: 'name', label: 'Name', type: 'string', required: true, choices: ['DDS', 'World']}]};
const plugin = (activate, changes = {}) => definePlugin({...manifest, ...changes}, activate);

test('v1 shape stays strict while v2 supports source visibility, runtime and compound license syntax', () => {
  assert.deepEqual(parseManifest(v1Manifest), v1Manifest);
  assert.throws(() => parseManifest({...v1Manifest, runtime: 'ui'}), hasCode(ErrorCode.INVALID_CONTRACT));
  const parsed = parseManifest({...manifest, source: {...manifest.source, repository: 'https://github.com/example/plugin'}});
  assert.equal(parsed.runtime, 'workspace');
  assert.ok(Object.isFrozen(parsed.source));
  assert.deepEqual(parseManifest(JSON.stringify(parsed)), parsed);
  for (const changes of [
    {runtime: 'ui'}, {source: {visibility: 'other', licenseFile: 'LICENSE'}},
    {source: {visibility: 'open', licenseFile: '../LICENSE'}},
    {source: {visibility: 'open', licenseFile: 'LICENSE', repository: 'https://user:password@example.com/repo'}},
    {source: {visibility: 'open', licenseFile: 'LICENSE', repository: 'http://example.com/repo'}},
    {source: {visibility: 'closed', licenseFile: 'LICENSE', extra: true}},
  ]) assert.throws(() => parseManifest({...manifest, ...changes}), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.equal(parseManifest({...manifest, runtime: 'ui', permissions: []}).runtime, 'ui');
  let getterCalls = 0;
  const bad = {...manifest}; Object.defineProperty(bad, 'manifestVersion', {enumerable: true, get() {getterCalls++;}});
  assert.throws(() => parseManifest(bad), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.equal(getterCalls, 0);
});

test('license parser validates expression syntax and bounded nesting without making license eligibility decisions', () => {
  for (const license of ['Apache-2.0', 'GPL-3.0-or-later WITH Classpath-exception-2.0', '(MIT OR Apache-2.0) AND LicenseRef-Custom', 'DocumentRef-Upstream:LicenseRef-Terms', 'GPL-2.0+']) assert.equal(parseLicenseExpression(license), license);
  for (const license of ['', 'MIT OR', 'MIT Apache-2.0', 'MIT AND (Apache-2.0', '(MIT) WITH Exception', 'LicenseRef-', 'MIT; rm', '('.repeat(17) + 'MIT' + ')'.repeat(17)]) assert.throws(() => parseLicenseExpression(license), hasCode(ErrorCode.INVALID_CONTRACT));
});

test('plain JSON copier rejects cycles, hooks, nonfinite values, depth/nodes/byte budgets and preserves immutable data', () => {
  const source = {nested: [{hello: 'DDS'}, null, true, 1.5]};
  const value = parseJsonValue(source); source.nested[0].hello = 'mutated';
  assert.equal(value.nested[0].hello, 'DDS'); assert.ok(Object.isFrozen(value.nested[0]));
  const cycle = {}; cycle.self = cycle;
  for (const invalid of [undefined, NaN, Infinity, 1n, new Date(), cycle, Array(1), {[Symbol('x')]: 1}]) assert.throws(() => parseJsonValue(invalid));
  let called = 0;
  assert.throws(() => parseJsonValue({get secret() {called++;}}), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.equal(called, 0);
  assert.equal(parseJsonValue('x'.repeat(LIMITS.jsonBytes - 2)).length, LIMITS.jsonBytes - 2);
  assert.throws(() => parseJsonValue('x'.repeat(LIMITS.jsonBytes - 1)), hasCode(ErrorCode.BUDGET_EXCEEDED));
  assert.throws(() => parseJsonValue('界'.repeat(LIMITS.jsonBytes / 3)), hasCode(ErrorCode.BUDGET_EXCEEDED));
  assert.throws(() => parseJsonValue(Array(LIMITS.jsonArrayItems + 1).fill(1)), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.throws(() => parseJsonValue(Object.fromEntries(Array.from({length: LIMITS.jsonObjectProperties + 1}, (_, i) => [`field${i}`, i]))), hasCode(ErrorCode.BUDGET_EXCEEDED));
  assert.throws(() => parseJsonValue(Array.from({length: 11}, () => Array(1000).fill(0))), hasCode(ErrorCode.BUDGET_EXCEEDED));
});

test('workspace relative paths and command metadata enforce bounded exact contracts', () => {
  assert.equal(parseWorkspacePath('src/design.sv'), 'src/design.sv');
  assert.equal(parseWorkspacePath('', {allowRoot: true}), '');
  for (const path of ['../secret', '/absolute', 'C:/secret', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a\0b']) assert.throws(() => parseWorkspacePath(path), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.ok(Object.isFrozen(parseCommandDefinition(command).parameters[0]));
  for (const metadata of [{...command, html: 'x'}, {...command, parameters: [...command.parameters, ...command.parameters]}, {...command, parameters: [{...command.parameters[0], type: 'number'}]}, {...command, title: 'x'.repeat(129)}]) assert.throws(() => parseCommandDefinition(metadata), hasCode(ErrorCode.INVALID_CONTRACT));
});

test('command registration, listing and input/output validation work with immutable copies', async () => {
  const host = createPluginHost({hostId: 'workspace-host'});
  let provided;
  await host.activate(plugin(context => context.registerCommand(command, (input, {signal}) => {provided = input; signal.throwIfAborted(); return {greeting: `Hello ${input.name}`};})));
  assert.deepEqual(host.listPlugins().map(plugin => plugin.id), [manifest.id]);
  assert.deepEqual(host.listCommands().map(value => ({id: value.id, pluginId: value.pluginId})), [{id: 'hello', pluginId: manifest.id}]);
  assert.equal((await host.executeCommand(manifest.id, 'hello', {name: 'DDS'})).greeting, 'Hello DDS');
  assert.ok(Object.isFrozen(provided));
  for (const input of [{}, {name: 1}, {name: 'Other'}, {name: 'DDS', extra: true}]) await assert.rejects(host.executeCommand(manifest.id, 'hello', input), hasCode(ErrorCode.INVALID_CONTRACT));
  await assert.rejects(host.executeCommand(manifest.id, 'missing', {}), hasCode(ErrorCode.CAPABILITY_UNAVAILABLE));
  host.dispose();
});

test('commands require declaration, reject duplicate IDs and rollback failed activation', async () => {
  const host = createPluginHost();
  await assert.rejects(host.activate(plugin(context => {context.registerCommand(command, () => null); context.registerCommand(command, () => null);})), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.equal(host.listCommands().length, 0); assert.equal(host.listPlugins().length, 0);
  await assert.rejects(host.activate(plugin(context => context.registerCommand(command, () => null), {capabilities: ['diagnostics']})), hasCode(ErrorCode.PERMISSION_DENIED));
  await assert.rejects(host.activate(plugin(() => undefined, {supportedHosts: ['workspace-host']})), hasCode(ErrorCode.UNSUPPORTED_HOST));
  host.dispose();
});

test('workspace and named backend calls receive only explicitly intersected grants and scoped frozen values', async () => {
  let context; let write; let backendOptions;
  const host = createPluginHost({hostId: 'workspace-host', scope: {projectId: 'p', sessionId: 's'}, grants: [...manifest.permissions, 'document.read'],
    workspace: {
      readFile: (path, {signal}) => {assert.ok(signal instanceof AbortSignal); return {path, content: 'hello', revision: 'r1'};},
      writeFile: (path, content, options) => {write = {path, content, options}; return {path, revision: 'r2'};},
      listFiles: () => [{path: 'src/design.sv', name: 'design.sv', size: 3, kind: 'file'}],
    },
    backends: {lint(input, options) {backendOptions = options; assert.ok(Object.isFrozen(input)); return {diagnostics: []};}},
  });
  await host.activate(plugin(value => {context = value;}));
  assert.deepEqual(context.grants, manifest.permissions); assert.ok(Object.isFrozen(context.grants));
  const read = await context.workspace.readFile('src/design.sv');
  assert.equal(read.content, 'hello'); assert.ok(Object.isFrozen(read));
  await context.workspace.writeFile(read.path, 'new', {expectedRevision: read.revision});
  assert.equal(write.options.expectedRevision, 'r1'); assert.equal(write.content, 'new');
  assert.equal((await context.workspace.listFiles('src'))[0].size, 3);
  await context.backends.invoke('lint', {path: read.path});
  assert.equal(backendOptions.pluginId, manifest.id); assert.deepEqual(backendOptions.scope, {projectId: 'p', sessionId: 's'});
  assert.throws(() => context.workspace.writeFile('src/design.sv', 'new', {}), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.throws(() => context.backends.invoke('not-configured', {}), hasCode(ErrorCode.CAPABILITY_UNAVAILABLE));
  host.dispose();
  assert.throws(() => context.workspace.readFile('src/design.sv'), hasCode(ErrorCode.DISPOSED));
});

test('ungranted, undeclared and absent ports fail closed without calling any injected handler', async () => {
  let calls = 0;
  for (const configuration of [{grants: []}, {grants: ['workspace.read'], changes: {permissions: []}}]) {
    let context;
    const host = createPluginHost({...configuration, workspace: {readFile() {calls++;}}});
    await host.activate(plugin(value => {context = value;}, configuration.changes));
    assert.throws(() => context.workspace.readFile('a.txt'), hasCode(ErrorCode.PERMISSION_DENIED));
    assert.throws(() => context.backends.invoke('lint', {}), hasCode(ErrorCode.PERMISSION_DENIED));
    host.dispose();
  }
  assert.equal(calls, 0);
  let context;
  const host = createPluginHost({grants: manifest.permissions}); await host.activate(plugin(value => {context = value;}));
  assert.throws(() => context.workspace.readFile('a.txt'), hasCode(ErrorCode.CAPABILITY_UNAVAILABLE));
  host.dispose();
});

test('trusted port conflict codes survive with redacted messages; plugin errors never expose private details', async () => {
  let context;
  const host = createPluginHost({grants: manifest.permissions, workspace: {writeFile() {const failure = new Error('private path'); failure.code = 'conflict'; throw failure;}}});
  await host.activate(plugin(value => {context = value; value.registerCommand({id: 'fail', title: 'Fail'}, () => {throw new PluginSdkError(ErrorCode.CONFLICT, 'private path');});}));
  await assert.rejects(context.workspace.writeFile('a.txt', 'x', {expectedRevision: 'old'}), failure => failure.code === ErrorCode.CONFLICT && !failure.message.includes('private'));
  await assert.rejects(host.executeCommand(manifest.id, 'fail', null), failure => failure.code === ErrorCode.PROVIDER_FAILED && !failure.message.includes('private'));
  host.dispose();
});

test('host validates port results including content byte limits, matching paths and listing scope', async () => {
  for (const result of [{path: 'wrong.txt', content: 'x', revision: 'r'}, {path: 'a.txt', content: 'x'.repeat(LIMITS.documentBytes + 1), revision: 'r'}, {path: 'a.txt', content: 'x', revision: ''}]) {
    let context; const host = createPluginHost({grants: ['workspace.read'], workspace: {readFile: () => result}});
    await host.activate(plugin(value => {context = value;}));
    await assert.rejects(context.workspace.readFile('a.txt')); host.dispose();
  }
  let context;
  const host = createPluginHost({grants: ['workspace.read'], workspace: {listFiles: () => [{path: 'outside.txt', kind: 'file'}]}});
  await host.activate(plugin(value => {context = value;}));
  await assert.rejects(context.workspace.listFiles('src'), hasCode(ErrorCode.INVALID_CONTRACT)); host.dispose();
});

test('command cancellation and timeout settle ignored providers, discard late results and permit reload', async () => {
  const started = deferred(); const finish = deferred(); let signal;
  const host = createPluginHost();
  await host.activate(plugin(context => context.registerCommand({id: 'wait', title: 'Wait'}, async (_, options) => {signal = options.signal; started.resolve(); await finish.promise; return 'late';})));
  const controller = new AbortController();
  const rejected = assert.rejects(host.executeCommand(manifest.id, 'wait', null, {signal: controller.signal}), hasCode(ErrorCode.CANCELLED));
  await started.promise; controller.abort(); await rejected; assert.ok(signal.aborted);
  await assert.rejects(host.executeCommand(manifest.id, 'wait', null, {timeoutMs: 5}), hasCode(ErrorCode.BUDGET_EXCEEDED));
  finish.resolve(); host.deactivate(manifest.id); assert.equal(host.listCommands().length, 0);
  await host.activate(plugin(context => context.registerCommand({id: 'wait', title: 'Wait'}, () => 'reloaded')));
  assert.equal(await host.executeCommand(manifest.id, 'wait', null), 'reloaded'); host.dispose();
});

test('pre-cancelled commands never execute and malformed results/options are rejected', async () => {
  let calls = 0;
  const host = createPluginHost();
  await host.activate(plugin(context => {
    context.registerCommand({id: 'count', title: 'Count'}, () => {calls++; return null;});
    context.registerCommand({id: 'invalid', title: 'Invalid'}, () => ({value: Infinity}));
    context.registerCommand({id: 'oversized', title: 'Oversized'}, () => 'x'.repeat(LIMITS.jsonBytes));
  }));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(host.executeCommand(manifest.id, 'count', null, {signal: controller.signal}), hasCode(ErrorCode.CANCELLED));
  assert.equal(calls, 0);
  for (const timeoutMs of [0, -1, 1.1, LIMITS.maxTimeoutMs + 1]) await assert.rejects(host.executeCommand(manifest.id, 'count', null, {timeoutMs}), hasCode(ErrorCode.INVALID_CONTRACT));
  let getter = 0;
  await assert.rejects(host.executeCommand(manifest.id, 'count', null, {get signal() {getter++;}}), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.equal(getter, 0);
  await assert.rejects(host.executeCommand(manifest.id, 'invalid', null), hasCode(ErrorCode.INVALID_CONTRACT));
  await assert.rejects(host.executeCommand(manifest.id, 'oversized', null), hasCode(ErrorCode.BUDGET_EXCEEDED));
  host.dispose();
});

test('workspace and backend operations cancel promptly and discard ignored late port results', async () => {
  for (const operation of ['read', 'backend']) {
    let context; let signal;
    const started = deferred(); const finish = deferred();
    const host = createPluginHost({grants: manifest.permissions,
      workspace: {async readFile(path, options) {signal = options.signal; started.resolve(); await finish.promise; return {path, content: 'late', revision: 'r'};}},
      backends: {async wait(_, options) {signal = options.signal; started.resolve(); await finish.promise; return 'late';}},
    });
    await host.activate(plugin(value => {context = value;}));
    const controller = new AbortController();
    const pending = operation === 'read' ? context.workspace.readFile('a.txt', {signal: controller.signal}) : context.backends.invoke('wait', null, {signal: controller.signal});
    const rejected = assert.rejects(pending, hasCode(ErrorCode.CANCELLED));
    await started.promise; controller.abort(); await rejected; assert.ok(signal.aborted);
    finish.resolve(); host.dispose();
  }
});

test('an activation in progress cannot expose commands or plugin metadata until ready', async () => {
  const started = deferred(); const finish = deferred();
  const host = createPluginHost();
  const activation = host.activate(plugin(async context => {context.registerCommand({id: 'wait', title: 'Wait'}, () => null); started.resolve(); await finish.promise;}));
  await started.promise;
  assert.equal(host.listCommands().length, 0); assert.equal(host.listPlugins().length, 0);
  await assert.rejects(host.executeCommand(manifest.id, 'wait', null), hasCode(ErrorCode.DISPOSED));
  finish.resolve(); await activation;
  assert.equal(host.listCommands().length, 1); assert.equal(host.listPlugins().length, 1); host.dispose();
});

for (const action of ['dispose', 'deactivate', 'registration']) test(`command ${action} aborts pending operations even when signal is ignored`, async () => {
  const started = deferred(); const finish = deferred(); let registration;
  const host = createPluginHost();
  await host.activate(plugin(context => {registration = context.registerCommand({id: 'wait', title: 'Wait'}, async () => {started.resolve(); await finish.promise; return null;});}));
  const rejected = assert.rejects(host.executeCommand(manifest.id, 'wait', null), hasCode(ErrorCode.DISPOSED));
  await started.promise;
  if (action === 'registration') registration.dispose(); else if (action === 'deactivate') host.deactivate(manifest.id); else host.dispose();
  await rejected; finish.resolve(); host.dispose();
});

test('command bounds retain cancelled pending slots until the provider actually settles', async () => {
  let context; const gates = [];
  const host = createPluginHost(); await host.activate(plugin(value => {context = value; value.registerCommand({id: 'wait', title: 'Wait'}, () => {const gate = deferred(); gates.push(gate); return gate.promise;});}));
  for (let index = 1; index < LIMITS.maxCommands; index++) context.registerCommand({id: `command-${index}`, title: 'Command'}, () => null);
  assert.throws(() => context.registerCommand({id: 'extra', title: 'Extra'}, () => null), hasCode(ErrorCode.BUDGET_EXCEEDED));
  const controllers = Array.from({length: LIMITS.maxPendingRequests}, () => new AbortController());
  const outcomes = controllers.map(controller => assert.rejects(host.executeCommand(manifest.id, 'wait', null, {signal: controller.signal}), hasCode(ErrorCode.CANCELLED)));
  await assert.rejects(host.executeCommand(manifest.id, 'wait', null), hasCode(ErrorCode.BUDGET_EXCEEDED));
  assert.equal(gates.length, LIMITS.maxPendingRequests);
  controllers[0].abort(); await outcomes[0];
  await assert.rejects(host.executeCommand(manifest.id, 'wait', null), hasCode(ErrorCode.BUDGET_EXCEEDED));
  gates[0].resolve(null); await new Promise(resolve => setImmediate(resolve));
  const replacement = new AbortController(); const replacementOutcome = assert.rejects(host.executeCommand(manifest.id, 'wait', null, {signal: replacement.signal}), hasCode(ErrorCode.CANCELLED));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gates.length, LIMITS.maxPendingRequests + 1);
  replacement.abort(); controllers.forEach(controller => controller.abort()); await Promise.all([...outcomes, replacementOutcome]);
  gates.forEach(gate => gate.resolve(null)); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await host.executeCommand(manifest.id, 'command-1', null), null);
  host.dispose();
});

test('schemas include both manifest versions, command metadata, bounded JSON and exact theme schema', () => {
  assert.deepEqual(SCHEMAS.manifest.oneOf.map(value => value.properties.manifestVersion.const), [1, 2]);
  assert.deepEqual(SCHEMAS.command.required, ['id', 'title']);
  assert.equal(SCHEMAS['json-value']['x-maxDepth'], LIMITS.jsonDepth);
  assert.equal(SCHEMAS.theme, THEME_SCHEMA);
});
