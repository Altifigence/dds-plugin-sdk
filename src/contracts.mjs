import { ErrorCode, LIMITS, PluginSdkError, PROTOCOL_VERSION } from './limits.mjs';
import { SEMVER_PATTERN } from './patterns.mjs';

const encoder = new TextEncoder();
const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const semverPattern = new RegExp(SEMVER_PATTERN);
const uriPattern = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/;
const permissions = ['document.read', 'diagnostics.publish'];

function fail(path, message) {
  throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, `${path}: ${message}`);
}

function input(value, bytes, path) {
  if (typeof value === 'string') {
    if (value.length > bytes || encoder.encode(value).length > bytes) {
      throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, `${path}: JSON byte limit exceeded`);
    }
    try { return JSON.parse(value); } catch { fail(path, 'expected valid JSON'); }
  }
  return value;
}

// Only account for the validated, accessor-free copy. Never stringify caller objects.
function boundCopy(value, bytes, path) {
  const json = JSON.stringify(value);
  if (json.length > bytes || encoder.encode(json).length > bytes) {
    throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, `${path}: JSON byte limit exceeded`);
  }
  return value;
}

function record(value, required, optional, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, 'expected a plain object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) fail(path, 'unexpected fields');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key)) fail(path, 'unexpected field');
    if (!('value' in descriptors[key]) || !descriptors[key].enumerable) fail(path, 'expected enumerable data fields');
  }
  for (const key of required) if (!Object.hasOwn(descriptors, key)) fail(`${path}.${key}`, 'required');
  return value;
}

function string(value, max, path, pattern) {
  if (typeof value !== 'string' || !value.length || value.length > max * 2) fail(path, `expected 1..${max} characters`);
  let characters = 0;
  for (const _character of value) {
    if (++characters > max) fail(path, `expected 1..${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail(path, 'invalid format');
  return value;
}

function integer(value, max, path, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `expected integer ${min}..${max}`);
  return value;
}

function enumeration(value, allowed, path) {
  if (!allowed.includes(value)) fail(path, `expected ${allowed.join(' | ')}`);
  return value;
}

function array(value, max, path, read, min = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) {
    fail(path, `expected array with ${min}..${max} entries`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) fail(path, 'sparse arrays and extra fields are unsupported');
  const entries = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail(path, 'expected array data entries');
    entries.push(read(descriptor.value, `${path}[${index}]`));
  }
  return entries;
}

function unique(values, path) {
  if (new Set(values).size !== values.length) fail(path, 'duplicate entries');
  return values;
}

function version(value, path) {
  if (value !== PROTOCOL_VERSION) throw new PluginSdkError(ErrorCode.VERSION_MISMATCH, `${path}: protocol version 1 required`);
  return value;
}

function scope(value, path) {
  record(value, ['projectId', 'sessionId'], [], path);
  return Object.freeze({
    projectId: string(value.projectId, 128, `${path}.projectId`),
    sessionId: string(value.sessionId, 128, `${path}.sessionId`),
  });
}

function snapshot(value, path, includeText) {
  record(value, ['uri', 'languageId', 'modelVersion', 'workspaceRevision', ...(includeText ? ['text'] : [])], [], path);
  const output = {
    uri: string(value.uri, 2_048, `${path}.uri`, uriPattern),
    languageId: string(value.languageId, 64, `${path}.languageId`, identifierPattern),
    modelVersion: integer(value.modelVersion, Number.MAX_SAFE_INTEGER, `${path}.modelVersion`, 1),
    workspaceRevision: string(value.workspaceRevision, 128, `${path}.workspaceRevision`),
  };
  if (includeText) {
    if (typeof value.text !== 'string') fail(`${path}.text`, 'expected text');
    if (value.text.length > LIMITS.documentBytes || encoder.encode(value.text).length > LIMITS.documentBytes) {
      throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, `${path}.text: document byte limit exceeded`);
    }
    output.text = value.text;
  }
  return Object.freeze(output);
}

function position(value, path) {
  record(value, ['line', 'character'], [], path);
  return Object.freeze({
    line: integer(value.line, LIMITS.documentBytes, `${path}.line`),
    character: integer(value.character, LIMITS.documentBytes, `${path}.character`),
  });
}

function diagnostic(value, path) {
  record(value, ['range', 'severity', 'message'], ['code', 'source'], path);
  record(value.range, ['start', 'end'], [], `${path}.range`);
  const start = position(value.range.start, `${path}.range.start`);
  const end = position(value.range.end, `${path}.range.end`);
  if (end.line < start.line || end.line === start.line && end.character < start.character) fail(`${path}.range`, 'end precedes start');
  const output = {
    range: Object.freeze({start, end}),
    severity: enumeration(value.severity, ['error', 'warning', 'info', 'hint'], `${path}.severity`),
    message: string(value.message, LIMITS.messageLength, `${path}.message`),
  };
  if (Object.hasOwn(value, 'code')) output.code = string(value.code, 128, `${path}.code`);
  if (Object.hasOwn(value, 'source')) output.source = string(value.source, 128, `${path}.source`);
  return Object.freeze(output);
}

/** Validate and return an immutable copy; input may be a plain object or bounded JSON string. */
export function parseManifest(value) {
  value = input(value, LIMITS.manifestBytes, 'manifest');
  record(value, ['manifestVersion', 'id', 'name', 'publisher', 'version', 'protocolVersion', 'entry', 'capabilities', 'permissions', 'supportedHosts', 'license'], [], 'manifest');
  if (value.manifestVersion !== 1) fail('manifest.manifestVersion', 'expected 1');
  const entry = string(value.entry, 256, 'manifest.entry');
  if (!/^\.\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.mjs$/.test(entry)) fail('manifest.entry', 'expected a relative .mjs module path');
  return boundCopy(Object.freeze({
    manifestVersion: 1,
    id: string(value.id, 128, 'manifest.id', identifierPattern),
    name: string(value.name, 128, 'manifest.name'),
    publisher: string(value.publisher, 128, 'manifest.publisher', identifierPattern),
    version: string(value.version, 64, 'manifest.version', semverPattern),
    protocolVersion: version(value.protocolVersion, 'manifest.protocolVersion'),
    entry,
    capabilities: Object.freeze(unique(array(value.capabilities, 1, 'manifest.capabilities', (v, p) => enumeration(v, ['diagnostics'], p), 1), 'manifest.capabilities')),
    permissions: Object.freeze(unique(array(value.permissions, 2, 'manifest.permissions', (v, p) => enumeration(v, permissions, p)), 'manifest.permissions')),
    supportedHosts: Object.freeze(unique(array(value.supportedHosts, 1, 'manifest.supportedHosts', (v, p) => enumeration(v, ['test-host'], p), 1), 'manifest.supportedHosts')),
    license: string(value.license, 128, 'manifest.license', /^[A-Za-z0-9.+-]+$/),
  }), LIMITS.manifestBytes, 'manifest');
}

export function parseDocumentSnapshot(value) { return snapshot(value, 'snapshot', true); }

export function parseDiagnosticsRequest(value) {
  value = input(value, LIMITS.requestBytes, 'request');
  record(value, ['protocolVersion', 'requestId', 'scope', 'snapshot'], [], 'request');
  return boundCopy(Object.freeze({
    protocolVersion: version(value.protocolVersion, 'request.protocolVersion'),
    requestId: string(value.requestId, 128, 'request.requestId'),
    scope: scope(value.scope, 'request.scope'),
    snapshot: snapshot(value.snapshot, 'request.snapshot', true),
  }), LIMITS.requestBytes, 'request');
}

export function parseDiagnosticsResult(value) {
  value = input(value, LIMITS.resultBytes, 'result');
  record(value, ['protocolVersion', 'requestId', 'scope', 'snapshot', 'diagnostics'], [], 'result');
  return boundCopy(Object.freeze({
    protocolVersion: version(value.protocolVersion, 'result.protocolVersion'),
    requestId: string(value.requestId, 128, 'result.requestId'),
    scope: scope(value.scope, 'result.scope'),
    snapshot: snapshot(value.snapshot, 'result.snapshot', false),
    diagnostics: Object.freeze(array(value.diagnostics, LIMITS.maxDiagnostics, 'result.diagnostics', diagnostic)),
  }), LIMITS.resultBytes, 'result');
}

export function createDiagnosticsResult(request, diagnostics) {
  const valid = parseDiagnosticsRequest(request);
  const {text: _text, ...identity} = valid.snapshot;
  return parseDiagnosticsResult({
    protocolVersion: PROTOCOL_VERSION,
    requestId: valid.requestId,
    scope: valid.scope,
    snapshot: identity,
    diagnostics,
  });
}

export function parseProviderSelector(value) {
  record(value, ['languages'], ['priority'], 'selector');
  return Object.freeze({
    languages: Object.freeze(unique(array(value.languages, 16, 'selector.languages', (v, p) => string(v, 64, p, identifierPattern), 1), 'selector.languages')),
    priority: Object.hasOwn(value, 'priority') ? integer(value.priority, 100, 'selector.priority', -100) : 0,
  });
}

export function parseGrants(value) {
  return Object.freeze(unique(array(value, 2, 'grants', (v, p) => enumeration(v, permissions, p)), 'grants'));
}

export function parseScope(value) { return scope(value, 'scope'); }

export function assertResultMatchesRequest(result, request) {
  if (result.requestId !== request.requestId || result.scope.projectId !== request.scope.projectId ||
      result.scope.sessionId !== request.scope.sessionId ||
      ['uri', 'languageId', 'modelVersion', 'workspaceRevision'].some(key => result.snapshot[key] !== request.snapshot[key])) {
    throw new PluginSdkError(ErrorCode.STALE_SNAPSHOT, 'Result identity does not match the requested snapshot');
  }
  const lines = request.snapshot.text.split(/\r\n|\n|\r/);
  for (const item of result.diagnostics) {
    for (const endpoint of [item.range.start, item.range.end]) {
      if (endpoint.line >= lines.length || endpoint.character > lines[endpoint.line].length) {
        fail('result.diagnostics.range', 'position is outside the requested document');
      }
    }
  }
}
