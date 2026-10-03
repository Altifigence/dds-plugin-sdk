import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorCode, LIMITS, createDiagnosticsResult, definePlugin, parseDiagnosticsRequest, parseDiagnosticsResult, parseDocumentSnapshot, parseManifest } from '../src/index.mjs';
import { clone, diagnostic, document, hasCode, manifest, request } from './fixtures.mjs';
import { SCHEMAS } from '../src/schemas.mjs';

test('valid object and JSON contracts are copied and deeply frozen', () => {
  const source = clone(request);
  const parsed = parseDiagnosticsRequest(source);
  source.snapshot.text = 'mutated';
  assert.equal(parsed.snapshot.text, document.text);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.snapshot) && Object.isFrozen(parsed.scope));
  assert.deepEqual(parseDiagnosticsRequest(JSON.stringify(request)), parsed);
  const result = createDiagnosticsResult(parsed, [diagnostic]);
  assert.equal(result.snapshot.text, undefined);
  assert.ok(Object.isFrozen(result.diagnostics[0].range.start));
  assert.deepEqual(parseDiagnosticsResult(JSON.stringify(result)), result);
  assert.deepEqual(parseManifest(JSON.stringify(manifest)), manifest);
});

test('manifest rejects unknown permissions, executable formats, versions and fields', () => {
  for (const replacement of [
    {permissions: ['shell.execute']}, {capabilities: ['filesystem']}, {entry: './plugin.js'},
    {entry: '../plugin.mjs'}, {entry: './src/../plugin.mjs'}, {entry: '/plugin.mjs'},
    {supportedHosts: ['dds-desktop']}, {version: 'latest'}, {id: 'bad id'},
    {permissions: ['document.read', 'document.read']}, {entry: './a.mjs', extra: true},
  ]) assert.throws(() => parseManifest({...manifest, ...replacement}), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.throws(() => parseManifest({...manifest, protocolVersion: 2}), hasCode(ErrorCode.VERSION_MISMATCH));
  assert.throws(() => parseManifest('x'.repeat(LIMITS.manifestBytes + 1)), hasCode(ErrorCode.BUDGET_EXCEEDED));
  assert.throws(() => definePlugin(manifest, null), hasCode(ErrorCode.INVALID_CONTRACT));
});

test('rejects malformed JSON, accessors, inherited objects and symbol fields without invoking getters', () => {
  const withGetter = clone(request);
  let calls = 0;
  Object.defineProperty(withGetter.snapshot, 'text', {enumerable: true, get() {calls++; throw new Error('getter');}});
  assert.throws(() => parseDiagnosticsRequest(withGetter), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.equal(calls, 0);
  for (const value of [null, [], 12, false, 'not JSON', {...request, [Symbol('x')]: 1}, Object.create(request)]) {
    assert.throws(() => parseDiagnosticsRequest(value), hasCode(ErrorCode.INVALID_CONTRACT));
  }
  const sparse = Array(1);
  assert.throws(() => parseDiagnosticsResult({...createDiagnosticsResult(request, []), diagnostics: sparse}), hasCode(ErrorCode.INVALID_CONTRACT));
  const arrayAccessor = [diagnostic];
  Object.defineProperty(arrayAccessor, '0', {enumerable: true, get() {calls++;}});
  assert.throws(() => createDiagnosticsResult(request, arrayAccessor), hasCode(ErrorCode.INVALID_CONTRACT));
  assert.equal(calls, 0);
  const prototypeField = JSON.parse(JSON.stringify(request).replace('"protocolVersion":1', '"__proto__":{},"protocolVersion":1'));
  assert.throws(() => parseDiagnosticsRequest(prototypeField), hasCode(ErrorCode.INVALID_CONTRACT));
});

test('document limits use UTF-8 bytes and accept empty/maximal text', () => {
  assert.equal(parseDocumentSnapshot({...document, text: ''}).text, '');
  assert.equal(parseDocumentSnapshot({...document, text: 'x'.repeat(LIMITS.documentBytes)}).text.length, LIMITS.documentBytes);
  for (const text of ['x'.repeat(LIMITS.documentBytes + 1), '😀'.repeat(LIMITS.documentBytes / 4 + 1)]) {
    assert.throws(() => parseDocumentSnapshot({...document, text}), hasCode(ErrorCode.BUDGET_EXCEEDED));
  }
  assert.throws(() => parseDiagnosticsRequest(' '.repeat(LIMITS.requestBytes + 1)), hasCode(ErrorCode.BUDGET_EXCEEDED));
  assert.throws(() => parseDiagnosticsResult(' '.repeat(LIMITS.resultBytes + 1)), hasCode(ErrorCode.BUDGET_EXCEEDED));
});

test('requests reject invalid identities and results reject unbounded or malformed diagnostics', () => {
  for (const snapshot of [{uri: 'relative.txt'}, {uri: 'memory:///bad\npath'}, {modelVersion: 0}, {modelVersion: NaN}, {modelVersion: Number.MAX_SAFE_INTEGER + 1}, {languageId: ''}, {workspaceRevision: ''}]) {
    assert.throws(() => parseDiagnosticsRequest({...request, snapshot: {...document, ...snapshot}}), hasCode(ErrorCode.INVALID_CONTRACT));
  }
  const maximum = createDiagnosticsResult(request, Array.from({length: LIMITS.maxDiagnostics}, () => diagnostic));
  assert.equal(maximum.diagnostics.length, LIMITS.maxDiagnostics);
  assert.throws(() => createDiagnosticsResult(request, Array.from({length: LIMITS.maxDiagnostics + 1}, () => diagnostic)), hasCode(ErrorCode.INVALID_CONTRACT));
  for (const changed of [
    {message: 'x'.repeat(LIMITS.messageLength + 1)}, {message: ''}, {severity: 'fatal'},
    {range: {start: {line: 2, character: 0}, end: {line: 1, character: 4}}},
    {range: {start: {line: 1, character: -1}, end: {line: 1, character: 4}}},
    {html: '<script></script>'},
  ]) assert.throws(() => createDiagnosticsResult(request, [{...diagnostic, ...changed}]), hasCode(ErrorCode.INVALID_CONTRACT));
});

test('aggregate result budgets apply equally to object and JSON inputs', () => {
  const result = {
    protocolVersion: 1, requestId: request.requestId, scope: request.scope,
    snapshot: {uri: document.uri, languageId: document.languageId, modelVersion: 1, workspaceRevision: document.workspaceRevision},
    diagnostics: Array.from({length: LIMITS.maxDiagnostics}, () => ({...diagnostic, message: '界'.repeat(LIMITS.messageLength)})),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > LIMITS.resultBytes);
  assert.throws(() => parseDiagnosticsResult(result), hasCode(ErrorCode.BUDGET_EXCEEDED));
  assert.throws(() => parseDiagnosticsResult(JSON.stringify(result)), hasCode(ErrorCode.BUDGET_EXCEEDED));
});

test('Unicode message limits use schema code-point semantics; positions remain UTF-16', () => {
  const limit = SCHEMAS['diagnostics-result'].properties.diagnostics.items.properties.message.maxLength;
  const message = '😀'.repeat(limit);
  assert.equal([...message].length, limit);
  assert.equal(createDiagnosticsResult(request, [{...diagnostic, message}]).diagnostics[0].message, message);
  assert.throws(() => createDiagnosticsResult(request, [{...diagnostic, message: message + '😀'}]), hasCode(ErrorCode.INVALID_CONTRACT));
});

test('SemVer prerelease numeric identifiers reject leading zeroes with schema/runtime parity', () => {
  const schemaPattern = new RegExp(SCHEMAS.manifest.properties.version.pattern);
  for (const version of ['0.1.0', '1.2.3-0', '1.2.3-alpha.0', '1.2.3-01alpha', '1.2.3+001']) {
    assert.ok(schemaPattern.test(version));
    assert.equal(parseManifest({...manifest, version}).version, version);
  }
  for (const version of ['01.0.0', '1.0.0-01', '1.0.0-alpha.01', '1.0.0-', '1.0.0+']) {
    assert.equal(schemaPattern.test(version), false);
    assert.throws(() => parseManifest({...manifest, version}), hasCode(ErrorCode.INVALID_CONTRACT));
  }
});
