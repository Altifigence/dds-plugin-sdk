import { ErrorCode, LIMITS, PluginSdkError, PROTOCOL_VERSION } from './limits.mjs';
import { SEMVER_PATTERN } from './patterns.mjs';

const encoder = new TextEncoder();
const identifierPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const semverPattern = new RegExp(SEMVER_PATTERN);
const uriPattern = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/;
const permissions = ['document.read', 'diagnostics.publish'];
const workspacePermissions = ['workspace.read', 'workspace.write', 'backend.invoke'];
const allPermissions = [...permissions, ...workspacePermissions, 'language.provide'];
export const LANGUAGE_FEATURES = Object.freeze(['completion', 'hover', 'definition', 'references', 'document-symbols']);

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
  if (value === null || typeof value !== 'object') fail('manifest', 'expected a plain object');
  const descriptor = Object.getOwnPropertyDescriptor(value, 'manifestVersion');
  const manifestVersion = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (![1, 2].includes(manifestVersion)) fail('manifest.manifestVersion', 'expected 1 or 2');
  record(value, ['manifestVersion', 'id', 'name', 'publisher', 'version', 'protocolVersion', 'entry', 'capabilities', 'permissions', 'supportedHosts', 'license', ...(manifestVersion === 2 ? ['runtime', 'source'] : [])], [], 'manifest');
  const entry = string(value.entry, 256, 'manifest.entry');
  if (!/^\.\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.mjs$/.test(entry)) fail('manifest.entry', 'expected a relative .mjs module path');
  const output = {
    manifestVersion,
    id: string(value.id, 128, 'manifest.id', identifierPattern),
    name: string(value.name, 128, 'manifest.name'),
    publisher: string(value.publisher, 128, 'manifest.publisher', identifierPattern),
    version: string(value.version, 64, 'manifest.version', semverPattern),
    protocolVersion: version(value.protocolVersion, 'manifest.protocolVersion'),
    entry,
    capabilities: Object.freeze(unique(array(value.capabilities, manifestVersion === 1 ? 1 : 7, 'manifest.capabilities', (v, p) => enumeration(v, manifestVersion === 1 ? ['diagnostics'] : ['diagnostics', 'commands', ...LANGUAGE_FEATURES], p), 1), 'manifest.capabilities')),
    permissions: Object.freeze(unique(array(value.permissions, manifestVersion === 1 ? 2 : 6, 'manifest.permissions', (v, p) => enumeration(v, manifestVersion === 1 ? permissions : allPermissions, p)), 'manifest.permissions')),
    supportedHosts: Object.freeze(unique(array(value.supportedHosts, manifestVersion === 1 ? 1 : 2, 'manifest.supportedHosts', (v, p) => enumeration(v, manifestVersion === 1 ? ['test-host'] : ['test-host', 'workspace-host'], p), 1), 'manifest.supportedHosts')),
    license: manifestVersion === 1 ? string(value.license, 128, 'manifest.license', /^[A-Za-z0-9.+-]+$/) : parseLicenseExpression(value.license),
  };
  if (manifestVersion === 2) {
    output.runtime = enumeration(value.runtime, ['ui', 'workspace'], 'manifest.runtime');
    if (output.runtime === 'ui' && output.permissions.some(permission => workspacePermissions.includes(permission))) fail('manifest.permissions', 'UI plugins cannot request workspace or backend permissions');
    record(value.source, ['visibility', 'licenseFile'], ['repository'], 'manifest.source');
    const source = {
      visibility: enumeration(value.source.visibility, ['open', 'closed'], 'manifest.source.visibility'),
      licenseFile: parseWorkspacePath(typeof value.source.licenseFile === 'string' && value.source.licenseFile.startsWith('./') ? value.source.licenseFile.slice(2) : value.source.licenseFile),
    };
    if (Object.hasOwn(value.source, 'repository')) {
      const repository = string(value.source.repository, 2048, 'manifest.source.repository');
      let url;
      try { url = new URL(repository); } catch { fail('manifest.source.repository', 'expected HTTPS URL'); }
      if (!/^https:\/\/[^\s?#]+$/.test(repository) || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) fail('manifest.source.repository', 'expected credential-free HTTPS repository URL');
      source.repository = repository;
    }
    output.source = Object.freeze(source);
  }
  return boundCopy(Object.freeze(output), LIMITS.manifestBytes, 'manifest');
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
  return Object.freeze(unique(array(value, 6, 'grants', (v, p) => enumeration(v, allPermissions, p)), 'grants'));
}

export function parseScope(value) { return scope(value, 'scope'); }

/** Validate syntax only; this does not decide whether a publisher may use a license. */
export function parseLicenseExpression(value) {
  string(value, 512, 'license');
  const tokens = value.match(/DocumentRef-[A-Za-z0-9.-]+:LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.+-]*|[()]|\S/g) ?? [];
  if (!tokens.length || tokens.length > 128) fail('license', 'invalid license expression');
  let index = 0;
  const identifier = token => typeof token === 'string' && !['AND', 'OR', 'WITH'].includes(token) &&
    /^(?:DocumentRef-[A-Za-z0-9.-]+:LicenseRef-[A-Za-z0-9.-]+|LicenseRef-[A-Za-z0-9.-]+|[A-Za-z0-9][A-Za-z0-9.-]*\+?)$/.test(token) && token !== 'LicenseRef-';
  function term(depth) {
    if (depth > 16) fail('license', 'expression nesting limit exceeded');
    if (tokens[index] === '(') {
      index++; expression(depth + 1);
      if (tokens[index++] !== ')') fail('license', 'unbalanced parentheses');
    } else {
      if (!identifier(tokens[index++])) fail('license', 'expected license identifier');
      if (tokens[index] === 'WITH') {
        index++;
        if (!identifier(tokens[index++])) fail('license', 'expected exception identifier');
      }
    }
  }
  function expression(depth) {
    term(depth);
    while (['AND', 'OR'].includes(tokens[index])) { index++; term(depth); }
  }
  expression(0);
  if (index !== tokens.length) fail('license', 'invalid license expression');
  return value;
}

export function parseWorkspacePath(value, {allowRoot = false} = {}) {
  if (allowRoot && value === '') return value;
  string(value, 1024, 'path');
  if (value.startsWith('/') || /[\\:\u0000-\u001f\u007f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('path', 'expected a workspace-relative slash path without traversal');
  return value;
}

/** Copy bounded plain JSON data without invoking accessors or serializing caller objects. */
export function parseJsonValue(value) {
  let bytes = 0;
  let nodes = 0;
  function account(serialized) {
    if (serialized.length > LIMITS.jsonBytes) throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'JSON byte limit exceeded');
    bytes += encoder.encode(serialized).length;
    if (bytes > LIMITS.jsonBytes) throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'JSON byte limit exceeded');
  }
  function visit(item, depth) {
    if (++nodes > LIMITS.jsonNodes || depth > LIMITS.jsonDepth) throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'JSON structural limit exceeded');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) { account(JSON.stringify(item)); return item; }
    if (typeof item === 'string') {
      if (item.length > LIMITS.jsonBytes) throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'JSON string limit exceeded');
      account(JSON.stringify(item)); return item;
    }
    if (Array.isArray(item)) {
      const result = array(item, LIMITS.jsonArrayItems, 'json', child => visit(child, depth + 1));
      account('[]'); if (result.length > 1) account(','.repeat(result.length - 1));
      return Object.freeze(result);
    }
    if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('json', 'expected finite plain JSON data');
    const keys = Reflect.ownKeys(item);
    if (keys.length > LIMITS.jsonObjectProperties) throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'JSON property limit exceeded');
    const output = {};
    account('{}');
    if (keys.length > 1) account(','.repeat(keys.length - 1));
    for (const key of keys) {
      if (typeof key !== 'string') fail('json', 'symbol fields are unsupported');
      string(key, 128, 'json.key');
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('json', 'expected enumerable data fields');
      account(`${JSON.stringify(key)}:`);
      Object.defineProperty(output, key, {value: visit(descriptor.value, depth + 1), enumerable: true});
    }
    return Object.freeze(output);
  }
  return visit(value, 0);
}

export function parseCommandDefinition(value) {
  record(value, ['id', 'title'], ['description', 'parameters'], 'command');
  const output = {id: string(value.id, 128, 'command.id', identifierPattern), title: string(value.title, 128, 'command.title')};
  if (Object.hasOwn(value, 'description')) output.description = string(value.description, 2048, 'command.description');
  if (Object.hasOwn(value, 'parameters')) output.parameters = Object.freeze(array(value.parameters, 32, 'command.parameters', (parameter, path) => {
    record(parameter, ['name', 'label', 'type', 'required'], ['choices'], path);
    if (typeof parameter.required !== 'boolean') fail(`${path}.required`, 'expected boolean');
    const parsed = {
      name: string(parameter.name, 128, `${path}.name`, identifierPattern), label: string(parameter.label, 128, `${path}.label`),
      type: enumeration(parameter.type, ['string', 'number', 'boolean'], `${path}.type`), required: parameter.required,
    };
    if (Object.hasOwn(parameter, 'choices')) {
      if (parsed.type !== 'string') fail(`${path}.choices`, 'choices require string type');
      parsed.choices = Object.freeze(unique(array(parameter.choices, 32, `${path}.choices`, (choice, p) => string(choice, 256, p), 1), `${path}.choices`));
    }
    return Object.freeze(parsed);
  }));
  if (output.parameters && new Set(output.parameters.map(parameter => parameter.name)).size !== output.parameters.length) fail('command.parameters', 'duplicate parameter names');
  return boundCopy(Object.freeze(output), LIMITS.commandBytes, 'command');
}

export function parseCommandInput(value, command) {
  const input = parseJsonValue(value);
  if (!command.parameters) return input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('command.input', 'expected parameter object');
  const allowed = command.parameters.map(parameter => parameter.name);
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('command.input', 'unexpected parameter');
  for (const parameter of command.parameters) {
    if (!Object.hasOwn(input, parameter.name)) { if (parameter.required) fail('command.input', 'required parameter missing'); continue; }
    const value = input[parameter.name];
    if (typeof value !== parameter.type || parameter.choices && !parameter.choices.includes(value)) fail('command.input', 'invalid parameter value');
  }
  return input;
}

// Internal port validators shared with the portable host.
export function parseWorkspaceRead(value, path) {
  record(value, ['path', 'content', 'revision'], [], 'workspace.readFile');
  if (parseWorkspacePath(value.path) !== path) fail('workspace.readFile.path', 'result path mismatch');
  return boundCopy(Object.freeze({path, content: parseFileContent(value.content), revision: string(value.revision, 128, 'workspace.revision')}), LIMITS.resultBytes, 'workspace.readFile');
}
export function parseWorkspaceWrite(value, path) {
  record(value, ['path', 'revision'], [], 'workspace.writeFile');
  if (parseWorkspacePath(value.path) !== path) fail('workspace.writeFile.path', 'result path mismatch');
  return Object.freeze({path, revision: string(value.revision, 128, 'workspace.revision')});
}
export function parseWorkspaceList(value, directory) {
  const result = Object.freeze(array(value, LIMITS.maxFiles, 'workspace.listFiles', (entry, path) => {
    record(entry, ['path', 'kind'], ['revision', 'name', 'size'], path);
    const name = parseWorkspacePath(entry.path);
    if (directory && !name.startsWith(`${directory}/`)) fail(path, 'file is outside the requested directory');
    const result = {path: name, kind: enumeration(entry.kind, ['file', 'directory'], `${path}.kind`)};
    if (Object.hasOwn(entry, 'name')) {
      result.name = string(entry.name, 1024, `${path}.name`);
      if (result.name !== name.split('/').at(-1)) fail(path, 'name does not match path');
    }
    if (Object.hasOwn(entry, 'size')) result.size = integer(entry.size, Number.MAX_SAFE_INTEGER, `${path}.size`);
    if (Object.hasOwn(entry, 'revision')) result.revision = string(entry.revision, 128, `${path}.revision`);
    return Object.freeze(result);
  }));
  if (new Set(result.map(entry => entry.path)).size !== result.length) fail('workspace.listFiles', 'duplicate paths');
  return boundCopy(result, LIMITS.resultBytes, 'workspace.listFiles');
}
export function parseFileContent(value) {
  if (typeof value !== 'string') fail('workspace.content', 'expected text');
  if (!value.isWellFormed()) fail('workspace.content', 'expected well-formed Unicode text');
  if (value.length > LIMITS.documentBytes || encoder.encode(value).length > LIMITS.documentBytes) throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'Workspace content byte limit exceeded');
  return value;
}
export function parseExpectedRevision(value) { return value === null ? null : string(value, 128, 'expectedRevision'); }

function assertIdentityMatches(result, request) {
  if (result.requestId !== request.requestId || result.scope.projectId !== request.scope.projectId ||
      result.scope.sessionId !== request.scope.sessionId ||
      ['uri', 'languageId', 'modelVersion', 'workspaceRevision'].some(key => result.snapshot[key] !== request.snapshot[key])) {
    throw new PluginSdkError(ErrorCode.STALE_SNAPSHOT, 'Result identity does not match the requested snapshot');
  }
}

export function assertResultMatchesRequest(result, request) {
  assertIdentityMatches(result, request);
  const lines = request.snapshot.text.split(/\r\n|\n|\r/);
  for (const item of result.diagnostics) {
    for (const endpoint of [item.range.start, item.range.end]) {
      if (endpoint.line >= lines.length || endpoint.character > lines[endpoint.line].length) {
        fail('result.diagnostics.range', 'position is outside the requested document');
      }
    }
  }
}

function range(value, path) {
  record(value, ['start', 'end'], [], path);
  const start = position(value.start, `${path}.start`);
  const end = position(value.end, `${path}.end`);
  if (comparePosition(start, end) > 0) fail(path, 'end precedes start');
  return Object.freeze({start, end});
}

function comparePosition(a, b) { return a.line - b.line || a.character - b.character; }
function inDocument(endpoint, text, path) {
  const lines = Array.isArray(text) ? text : text.split(/\r\n|\n|\r/);
  if (endpoint.line >= lines.length || endpoint.character > lines[endpoint.line].length) fail(path, 'position is outside the requested document');
}
function inDocumentRange(value, text) {
  inDocument(value.start, text, 'range.start'); inDocument(value.end, text, 'range.end');
}

/** Language API v1: plain text only. Returned text is never HTML or a command. */
export function parseLanguageRequest(value) {
  value = input(value, LIMITS.requestBytes, 'request');
  record(value, ['protocolVersion', 'requestId', 'scope', 'snapshot', 'kind'], ['position', 'includeDeclaration'], 'request');
  const kind = enumeration(value.kind, LANGUAGE_FEATURES, 'request.kind');
  const output = {
    protocolVersion: version(value.protocolVersion, 'request.protocolVersion'),
    requestId: string(value.requestId, 128, 'request.requestId'),
    scope: scope(value.scope, 'request.scope'), snapshot: snapshot(value.snapshot, 'request.snapshot', true), kind,
  };
  if (kind === 'document-symbols') {
    if (Object.hasOwn(value, 'position')) fail('request.position', 'document symbols do not take a position');
  } else {
    output.position = position(value.position, 'request.position');
    inDocument(output.position, output.snapshot.text, 'request.position');
  }
  if (Object.hasOwn(value, 'includeDeclaration')) {
    if (kind !== 'references' || typeof value.includeDeclaration !== 'boolean') fail('request.includeDeclaration', 'only references accept a boolean');
    output.includeDeclaration = value.includeDeclaration;
  }
  return boundCopy(Object.freeze(output), LIMITS.requestBytes, 'request');
}

function completion(value, path) {
  record(value, ['label', 'insertText'], ['detail', 'range'], path);
  const output = {label: string(value.label, 256, `${path}.label`), insertText: parseFileContent(value.insertText)};
  if (value.insertText !== '') string(value.insertText, 16_384, `${path}.insertText`);
  if (Object.hasOwn(value, 'detail')) output.detail = string(value.detail, 2048, `${path}.detail`);
  if (Object.hasOwn(value, 'range')) output.range = range(value.range, `${path}.range`);
  return Object.freeze(output);
}
function hover(value, path) {
  if (value === null) return null;
  record(value, ['text'], ['range'], path);
  const output = {text: string(value.text, 16_384, `${path}.text`)};
  if (Object.hasOwn(value, 'range')) output.range = range(value.range, `${path}.range`);
  return Object.freeze(output);
}
function location(value, path) {
  record(value, ['path', 'range'], [], path);
  return Object.freeze({path: parseWorkspacePath(value.path), range: range(value.range, `${path}.range`)});
}
function symbol(value, path) {
  record(value, ['name', 'kind', 'range', 'selectionRange'], ['detail'], path);
  const output = {
    name: string(value.name, 256, `${path}.name`),
    kind: enumeration(value.kind, ['module', 'namespace', 'class', 'interface', 'function', 'method', 'variable', 'constant', 'property', 'type'], `${path}.kind`),
    range: range(value.range, `${path}.range`), selectionRange: range(value.selectionRange, `${path}.selectionRange`),
  };
  if (comparePosition(output.range.start, output.selectionRange.start) > 0 || comparePosition(output.selectionRange.end, output.range.end) > 0) fail(path, 'selectionRange must be inside range');
  if (Object.hasOwn(value, 'detail')) output.detail = string(value.detail, 2048, `${path}.detail`);
  return Object.freeze(output);
}

export function parseLanguageResult(value) {
  value = input(value, LIMITS.resultBytes, 'result');
  record(value, ['protocolVersion', 'requestId', 'scope', 'snapshot', 'kind', 'data'], [], 'result');
  const kind = enumeration(value.kind, LANGUAGE_FEATURES, 'result.kind');
  const readers = {completion, hover, definition: location, references: location, 'document-symbols': symbol};
  return boundCopy(Object.freeze({
    protocolVersion: version(value.protocolVersion, 'result.protocolVersion'),
    requestId: string(value.requestId, 128, 'result.requestId'), scope: scope(value.scope, 'result.scope'),
    snapshot: snapshot(value.snapshot, 'result.snapshot', false), kind,
    data: kind === 'hover' ? hover(value.data, 'result.data') : Object.freeze(array(value.data, LIMITS.maxLanguageItems, 'result.data', readers[kind])),
  }), LIMITS.resultBytes, 'result');
}

export function assertLanguageResultMatchesRequest(result, request) {
  assertIdentityMatches(result, request);
  if (result.kind !== request.kind) fail('result.kind', 'does not match request');
  if (['definition', 'references'].includes(result.kind)) return; // Target contents require a separately authorized workspace read.
  const entries = result.kind === 'hover' ? (result.data ? [result.data] : []) : result.data;
  const lines = request.snapshot.text.split(/\r\n|\n|\r/);
  for (const entry of entries) {
    if (entry.range) inDocumentRange(entry.range, lines);
    if (entry.selectionRange) inDocumentRange(entry.selectionRange, lines);
  }
}

export function createLanguageResult(request, data) {
  const valid = parseLanguageRequest(request);
  const {text: _text, ...identity} = valid.snapshot;
  const result = parseLanguageResult({protocolVersion: 1, requestId: valid.requestId, scope: valid.scope, snapshot: identity, kind: valid.kind, data});
  assertLanguageResultMatchesRequest(result, valid);
  return result;
}
