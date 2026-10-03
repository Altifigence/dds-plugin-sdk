import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, LIMITS, PluginSdkError, createDiagnosticsRegistry, createDiagnosticsResult, definePlugin } from '../src/index.mjs';
import { createTestHost } from '../src/testing.mjs';
import { deferred, diagnostic, document, hasCode, makePlugin, manifest, request } from './fixtures.mjs';

async function ready(plugin, options) {
  const host = createTestHost(options);
  await host.activate(plugin);
  host.setDocument(document);
  return host;
}

test('granted plugin runs and has immutable, scoped context; manifest grants no authority', async () => {
  let observed;
  const plugin = definePlugin(manifest, context => {
    observed = context;
    return context.registerDiagnosticsProvider({languages: ['plaintext']}, {provideDiagnostics: req => createDiagnosticsResult(req, [diagnostic])});
  });
  const host = await ready(plugin, {scope: {projectId: 'own-project', sessionId: 'own-session'}});
  try {
    const result = await host.requestDiagnostics();
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.scope.projectId, 'own-project');
    assert.equal(observed.host.id, 'test-host');
    assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.grants));
    const denied = createTestHost({grants: ['document.read']});
    await assert.rejects(denied.activate(plugin), hasCode(ErrorCode.PERMISSION_DENIED));
    denied.dispose();
    const undeclared = createTestHost();
    await assert.rejects(undeclared.activate(makePlugin(undefined, {permissions: []})), hasCode(ErrorCode.PERMISSION_DENIED));
    undeclared.dispose();
  } finally {host.dispose();}
});

test('selection uses highest priority, then earliest active registration; disposal is idempotent', async () => {
  const host = createTestHost();
  function plugin(id, priority, message) {
    return definePlugin({...manifest, id}, context => context.registerDiagnosticsProvider({languages: ['plaintext'], priority}, {
      provideDiagnostics: req => createDiagnosticsResult(req, [{...diagnostic, message}]),
    }));
  }
  const first = await host.activate(plugin('first', 1, 'first'));
  const second = await host.activate(plugin('second', 1, 'second'));
  const highest = await host.activate(plugin('highest', 5, 'highest'));
  host.setDocument(document);
  assert.equal((await host.requestDiagnostics()).diagnostics[0].message, 'highest');
  highest.dispose(); highest.dispose();
  assert.equal((await host.requestDiagnostics()).diagnostics[0].message, 'first');
  first.dispose();
  assert.equal((await host.requestDiagnostics()).diagnostics[0].message, 'second');
  second.dispose();
  await assert.rejects(host.requestDiagnostics(), hasCode(ErrorCode.PROVIDER_UNAVAILABLE));
  host.dispose(); host.dispose();
  await assert.rejects(host.requestDiagnostics(), hasCode(ErrorCode.DISPOSED));
});

test('caller cancellation settles promptly even when a provider ignores the signal and returns late', async () => {
  const started = deferred();
  const finish = deferred();
  let providerSignal;
  const host = await ready(makePlugin(async (req, {signal}) => {providerSignal = signal; started.resolve(); await finish.promise; return createDiagnosticsResult(req, [diagnostic]);}));
  const controller = new AbortController();
  const pending = host.requestDiagnostics({signal: controller.signal});
  const rejected = assert.rejects(pending, hasCode(ErrorCode.CANCELLED));
  await started.promise;
  controller.abort(new Error('caller secret'));
  await rejected;
  assert.equal(providerSignal.aborted, true);
  finish.resolve();
  await Promise.resolve();
  host.dispose();
});

test('pre-aborted requests never invoke providers; timeout enforces a budget', async () => {
  let calls = 0;
  const host = await ready(makePlugin(() => {calls++; return new Promise(() => {});}));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(host.requestDiagnostics({signal: controller.signal}), hasCode(ErrorCode.CANCELLED));
  assert.equal(calls, 0);
  await assert.rejects(host.requestDiagnostics({timeoutMs: 5}), hasCode(ErrorCode.BUDGET_EXCEEDED));
  for (const timeoutMs of [0, -1, 1.2, LIMITS.maxTimeoutMs + 1]) {
    await assert.rejects(host.requestDiagnostics({timeoutMs}), hasCode(ErrorCode.INVALID_CONTRACT));
  }
  host.dispose();
});

for (const change of [
  {...document, text: 'changed', modelVersion: 2},
  {...document, uri: 'memory:///other.txt'},
  {...document, workspaceRevision: 'rev-2'},
]) test(`document change cancels and discards ignored late results: ${JSON.stringify(change)}`, async () => {
  const started = deferred(); const finish = deferred(); let signal;
  const host = await ready(makePlugin(async (req, options) => {signal = options.signal; started.resolve(); await finish.promise; return createDiagnosticsResult(req, []);}));
  const pending = host.requestDiagnostics();
  const rejected = assert.rejects(pending, hasCode(ErrorCode.STALE_SNAPSHOT));
  await started.promise;
  host.setDocument(change);
  await rejected;
  assert.ok(signal.aborted);
  finish.resolve();
  host.dispose();
});

test('host detects wrong response identity and ranges beyond active text', async () => {
  for (const mutate of [
    result => ({...result, requestId: 'wrong'}),
    result => ({...result, scope: {...result.scope, projectId: 'wrong'}}),
    result => ({...result, snapshot: {...result.snapshot, modelVersion: 2}}),
    result => ({...result, snapshot: {...result.snapshot, uri: 'memory:///wrong.txt'}}),
  ]) {
    const host = await ready(makePlugin(req => mutate(createDiagnosticsResult(req, []))));
    await assert.rejects(host.requestDiagnostics(), hasCode(ErrorCode.STALE_SNAPSHOT));
    host.dispose();
  }
  const host = await ready(makePlugin(req => createDiagnosticsResult(req, [{...diagnostic, range: {start: {line: 50, character: 0}, end: {line: 50, character: 1}}}])));
  await assert.rejects(host.requestDiagnostics(), hasCode(ErrorCode.INVALID_CONTRACT));
  host.dispose();
});

test('deactivate removes registrations, aborts running requests, supports clean reload', async () => {
  let signal;
  const started = deferred(); const finish = deferred();
  const host = await ready(makePlugin(async (req, options) => {signal = options.signal; started.resolve(); await finish.promise; return createDiagnosticsResult(req, []);}));
  const pending = host.requestDiagnostics();
  const rejected = assert.rejects(pending, hasCode(ErrorCode.DISPOSED));
  await started.promise;
  host.deactivate(manifest.id);
  await rejected;
  assert.ok(signal.aborted);
  finish.resolve();
  await host.activate(makePlugin());
  assert.equal((await host.requestDiagnostics()).diagnostics.length, 0);
  host.dispose();
});

test('host dispose cancels queued requests before invocation and owns cleanup', async () => {
  let calls = 0; let context;
  const host = await ready(definePlugin(manifest, value => {
    context = value;
    value.registerDiagnosticsProvider({languages: ['plaintext']}, {provideDiagnostics(req) {calls++; return createDiagnosticsResult(req, []);}});
    return {dispose() {throw new Error('broken custom cleanup');}};
  }));
  const pending = host.requestDiagnostics();
  const rejected = assert.rejects(pending, hasCode(ErrorCode.DISPOSED));
  host.dispose();
  await rejected;
  assert.equal(calls, 0);
  assert.ok(context.signal.aborted);
  assert.throws(() => context.registerDiagnosticsProvider({languages: ['plaintext']}, {}), hasCode(ErrorCode.DISPOSED));
});

test('activation rollback removes registrations and redacts provider exception messages', async () => {
  const host = createTestHost();
  await assert.rejects(host.activate(definePlugin(manifest, context => {
    context.registerDiagnosticsProvider({languages: ['plaintext']}, {provideDiagnostics: req => createDiagnosticsResult(req, [])});
    throw new Error('secret private path');
  })), error => error.code === ErrorCode.PROVIDER_FAILED && !error.message.includes('secret'));
  host.setDocument(document);
  await assert.rejects(host.requestDiagnostics(), hasCode(ErrorCode.PROVIDER_UNAVAILABLE));
  await host.activate(makePlugin(() => {throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, 'secret');}));
  await assert.rejects(host.requestDiagnostics(), error => error.code === ErrorCode.PROVIDER_FAILED && !error.message.includes('secret'));
  host.dispose();
  const untrusted = createTestHost();
  await assert.rejects(untrusted.activate(definePlugin(manifest, () => {
    throw new PluginSdkError(ErrorCode.PERMISSION_DENIED, 'C:/private/design secret');
  })), failure => failure.code === ErrorCode.PROVIDER_FAILED && !failure.message.includes('secret') && !failure.message.includes('private'));
  untrusted.dispose();
});

test('invalid document edit is rejected without replacing the current document', async () => {
  const host = await ready(makePlugin(req => createDiagnosticsResult(req, [diagnostic])));
  assert.throws(() => host.setDocument({...document, text: 'edited'}), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.equal((await host.requestDiagnostics()).diagnostics.length, 1);
  host.dispose();
});

test('disposing during ignored async activation settles and cleans a late disposable exactly once', async () => {
  const started = deferred(); const finish = deferred(); let disposed = 0;
  const host = createTestHost();
  const activation = host.activate(definePlugin(manifest, async context => {
    context.registerDiagnosticsProvider({languages: ['plaintext']}, {provideDiagnostics: req => createDiagnosticsResult(req, [])});
    started.resolve();
    await finish.promise;
    return {dispose() {disposed++;}};
  }));
  const rejected = assert.rejects(activation, hasCode(ErrorCode.DISPOSED));
  await started.promise;
  host.dispose();
  await rejected;
  finish.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, 1);
});

for (const action of ['dispose', 'deactivate']) test(`activation rechecks ${action} after provider resolution and before host continuation`, async () => {
  const host = createTestHost(); let disposals = 0;
  const activation = host.activate(definePlugin(manifest, () => ({dispose() {disposals++;}})));
  const rejected = assert.rejects(activation, hasCode(ErrorCode.DISPOSED));
  queueMicrotask(() => queueMicrotask(() => action === 'dispose' ? host.dispose() : host.deactivate(manifest.id)));
  await rejected;
  assert.equal(disposals, 1);
  host.dispose();
  assert.equal(disposals, 1);
});

test('a cancelled never-finishing request releases a pending slot for the next request', async () => {
  const registry = createDiagnosticsRegistry();
  registry.register('pending', {languages: ['plaintext']}, {provideDiagnostics: () => new Promise(() => {})});
  const controllers = Array.from({length: LIMITS.maxPendingRequests}, () => new AbortController());
  const rejected = controllers.map(controller => assert.rejects(registry.request(request, {signal: controller.signal}), hasCode(ErrorCode.CANCELLED)));
  controllers[0].abort();
  await rejected[0];
  const replacement = new AbortController();
  const replacementRejected = assert.rejects(registry.request(request, {signal: replacement.signal}), hasCode(ErrorCode.CANCELLED));
  replacement.abort();
  for (const controller of controllers) controller.abort();
  await Promise.all([...rejected, replacementRejected]);
  registry.dispose();
});

test('registry bounds providers and concurrent pending requests', async () => {
  const registry = createDiagnosticsRegistry();
  for (let i = 0; i < LIMITS.maxRegistrations; i++) registry.register(`p-${i}`, {languages: ['plaintext']}, {provideDiagnostics: () => new Promise(() => {})});
  assert.throws(() => registry.register('extra', {languages: ['plaintext']}, {provideDiagnostics() {}}), hasCode(ErrorCode.BUDGET_EXCEEDED));
  const requests = Array.from({length: LIMITS.maxPendingRequests}, () => registry.request(request));
  const settled = Promise.all(requests.map(promise => assert.rejects(promise, hasCode(ErrorCode.DISPOSED))));
  await assert.rejects(registry.request(request), hasCode(ErrorCode.BUDGET_EXCEEDED));
  registry.dispose();
  await settled;
});
