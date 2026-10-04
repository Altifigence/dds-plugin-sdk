import {parseManifest, parseCommandDefinition} from './contracts.mjs';
import {isPrivateFileComponent, isSafeWorkspaceRelativePath} from './patterns.mjs';
import {parseJobId, parseJobOptions, parseJobSnapshot, parseJobEvents, parseJobCapabilities, parseJobArtifactContent} from './jobs.mjs';
import {parseBinaryArtifactRange, parseBinaryArtifactList, parseBinaryArtifactCapabilities, parseBinaryArtifactChunk} from './artifacts.mjs';
export const WORKSPACE_PROTOCOL_VERSION = 1;
export const WORKSPACE_PATH = '/dds/workspace/v1';
export const WORKSPACE_LIMITS = Object.freeze({wireBytes: 1_600_000, fileBytes: 262_144, jsonBytes: 262_144, depth: 16, nodes: 10_000, entries: 1_000, plugins: 32, pending: 64, receiving: 16, connections: 128, defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000});
export const WORKSPACE_METHODS = Object.freeze(['hello', 'fs.list', 'fs.read', 'fs.capabilities', 'fs.revision', 'fs.readIfChanged', 'fs.write', 'fs.mkdir', 'fs.rename', 'fs.remove', 'plugins.list', 'commands.run', 'request.cancel', 'jobs.capabilities', 'jobs.start', 'jobs.get', 'jobs.events', 'jobs.cancel', 'jobs.artifact', 'artifacts.capabilities', 'artifacts.list', 'artifacts.read']);
export const WORKSPACE_ERROR_CODES = Object.freeze(['invalid_request', 'authentication_required', 'permission_denied', 'workspace_mismatch', 'generation_mismatch', 'not_found', 'conflict', 'unsafe_path', 'budget_exceeded', 'cancelled', 'disposed', 'plugin_mismatch', 'provider_failed', 'unsupported', 'unavailable', 'transport_failed']);
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = /^[0-9a-f]{64}$/;

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(String(message).slice(0, 2_048));
    this.name = 'WorkspaceError';
    this.code = WORKSPACE_ERROR_CODES.includes(code) ? code : 'invalid_request';
  }
}
export const workspaceFailure = (code, message) => new WorkspaceError(code, message);
const invalid = () => { throw workspaceFailure('invalid_request', 'Invalid workspace contract'); };
export function requireText(value, maximum = 128) {
  if (typeof value !== 'string' || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  return value;
}
export function requireUuid(value) { if (typeof value !== 'string' || !uuid.test(value)) invalid(); return value; }
export function requireSha256(value) { if (typeof value !== 'string' || !sha.test(value)) invalid(); return value; }
export function requireToken(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 512 || !/^[A-Za-z0-9._~+/-]+$/.test(value)) {
    throw workspaceFailure('authentication_required', 'A valid operator token is required');
  }
  return value;
}
/** Exact API exclusions, case-insensitive on every platform. Ordinary dotfiles are allowed. */
export function isProtectedWorkspaceComponent(value) {
  return isPrivateFileComponent(value) || /^\.dds-write-/i.test(value);
}
export function requireWorkspacePath(value, allowRoot = false) {
  if (allowRoot && value === '') return value;
  if (!isSafeWorkspaceRelativePath(value)) {
    throw workspaceFailure('unsafe_path', 'Invalid workspace path');
  }
  return value;
}
export function requireFileContent(value) {
  if (typeof value !== 'string') invalid();
  if (value.length > WORKSPACE_LIMITS.fileBytes || encoder.encode(value).byteLength > WORKSPACE_LIMITS.fileBytes) throw workspaceFailure('budget_exceeded', 'File content limit exceeded');
  // Reject unpaired UTF-16 surrogates rather than silently changing bytes on encode.
  if (!value.isWellFormed()) invalid();
  return value;
}
export function exactObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length || required.some(key => !Object.hasOwn(value, key))) invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) invalid();
  }
  return value;
}

/** Copy plain JSON without invoking accessors or caller toJSON methods. */
export function copyWorkspaceJson(value, {maxBytes = WORKSPACE_LIMITS.jsonBytes, maxDepth = WORKSPACE_LIMITS.depth, maxNodes = WORKSPACE_LIMITS.nodes} = {}) {
  let nodes = 0, bytes = 0;
  const account = serialized => {
    if (serialized.length > maxBytes) throw workspaceFailure('budget_exceeded', 'JSON byte limit exceeded');
    bytes += encoder.encode(serialized).byteLength;
    if (bytes > maxBytes) throw workspaceFailure('budget_exceeded', 'JSON byte limit exceeded');
  };
  const visit = (input, depth) => {
    if (++nodes > maxNodes || depth > maxDepth) throw workspaceFailure('budget_exceeded', 'JSON structure limit exceeded');
    if (input === null || typeof input === 'boolean') { account(JSON.stringify(input)); return input; }
    if (typeof input === 'string') { if (input.length > maxBytes) throw workspaceFailure('budget_exceeded', 'JSON byte limit exceeded'); if (!input.isWellFormed()) invalid(); account(JSON.stringify(input)); return input; }
    if (typeof input === 'number') { if (!Number.isFinite(input)) invalid(); account(JSON.stringify(input)); return input; }
    if (!input || typeof input !== 'object') invalid();
    const keys = Reflect.ownKeys(input);
    if (keys.length > maxNodes) throw workspaceFailure('budget_exceeded', 'JSON structure limit exceeded');
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype || input.length > maxNodes || keys.length !== input.length + 1) invalid();
      account('[]'); if (input.length > 1) account(','.repeat(input.length - 1));
      return Object.freeze(Array.from({length: input.length}, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) invalid();
        return visit(descriptor.value, depth + 1);
      }));
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
    const output = {};
    account('{}'); if (keys.length > 1) account(','.repeat(keys.length - 1));
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key) || !descriptor?.enumerable || !('value' in descriptor)) invalid();
      account(`${JSON.stringify(key)}:`);
      output[key] = visit(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  };
  return visit(value, 0);
}

function wireInput(value) {
  if (typeof value === 'string') {
    if (value.length > WORKSPACE_LIMITS.wireBytes || encoder.encode(value).byteLength > WORKSPACE_LIMITS.wireBytes) throw workspaceFailure('budget_exceeded', 'Workspace message limit exceeded');
    try { value = JSON.parse(value); } catch { invalid(); }
  }
  return copyWorkspaceJson(value, {maxBytes: WORKSPACE_LIMITS.wireBytes, maxDepth: 24, maxNodes: 40_000});
}
export function parseWorkspaceRequest(value) {
  value = wireInput(value);
  exactObject(value, ['version', 'requestId', 'method', 'params'], ['workspaceId', 'generation']);
  if (value.version !== 1 || !WORKSPACE_METHODS.includes(value.method)) invalid();
  requireText(value.requestId);
  if (value.method !== 'hello') { requireUuid(value.workspaceId); requireUuid(value.generation); }
  else { if (value.workspaceId !== undefined) requireUuid(value.workspaceId); if (value.generation !== undefined) requireUuid(value.generation); }
  const p = value.params;
  switch (value.method) {
    case 'hello': case 'plugins.list': case 'jobs.capabilities': case 'fs.capabilities': case 'artifacts.capabilities': exactObject(p, []); break;
    case 'fs.list': exactObject(p, ['path']); requireWorkspacePath(p.path, true); break;
    case 'fs.read': case 'fs.revision': case 'fs.mkdir': exactObject(p, ['path']); requireWorkspacePath(p.path); break;
    case 'fs.readIfChanged': exactObject(p, ['path', 'knownRevision']); requireWorkspacePath(p.path); if (p.knownRevision !== null) requireSha256(p.knownRevision); break;
    case 'fs.write': exactObject(p, ['path', 'content', 'expectedRevision']); requireWorkspacePath(p.path); requireFileContent(p.content); if (p.expectedRevision !== null) requireSha256(p.expectedRevision); break;
    case 'fs.rename': exactObject(p, ['path', 'newPath'], ['expectedRevision']); requireWorkspacePath(p.path); requireWorkspacePath(p.newPath); if (p.expectedRevision !== undefined) requireSha256(p.expectedRevision); break;
    case 'fs.remove': exactObject(p, ['path'], ['expectedRevision']); requireWorkspacePath(p.path); if (p.expectedRevision !== undefined) requireSha256(p.expectedRevision); break;
    case 'commands.run': exactObject(p, ['pluginId', 'commandId', 'input', 'artifactSha256']); requireText(p.pluginId); requireText(p.commandId); requireSha256(p.artifactSha256); copyWorkspaceJson(p.input); break;
    case 'request.cancel': exactObject(p, ['requestId']); requireText(p.requestId); break;
    case 'jobs.start':
      exactObject(p, ['pluginId', 'commandId', 'input', 'artifactSha256', 'jobId'], ['timeoutMs']);
      requireText(p.pluginId); requireText(p.commandId); requireSha256(p.artifactSha256); copyWorkspaceJson(p.input);
      try {parseJobOptions({jobId: p.jobId, ...(p.timeoutMs === undefined ? {} : {timeoutMs: p.timeoutMs})});} catch {invalid();} break;
    case 'jobs.get': case 'jobs.cancel': case 'artifacts.list': exactObject(p, ['jobId']); try {parseJobId(p.jobId);} catch {invalid();} break;
    case 'jobs.events': exactObject(p, ['jobId', 'after']); try {parseJobId(p.jobId);} catch {invalid();} if (!Number.isSafeInteger(p.after) || p.after < 0) invalid(); break;
    case 'jobs.artifact': exactObject(p, ['jobId', 'artifactId']); try {parseJobId(p.jobId);} catch {invalid();} requireText(p.artifactId); break;
    case 'artifacts.read':
      exactObject(p, ['jobId', 'artifactId', 'revision', 'offset', 'length']); requireText(p.artifactId); requireSha256(p.revision);
      try {parseJobId(p.jobId); parseBinaryArtifactRange(p.offset, p.length);} catch {invalid();} break;
  }
  return value;
}
export function parseWorkspaceReply(value, expectedRequestId) {
  value = wireInput(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (value.ok === true) exactObject(value, ['version', 'requestId', 'ok', 'result']);
  else if (value.ok === false) {
    exactObject(value, ['version', 'requestId', 'ok', 'error']);
    exactObject(value.error, ['code', 'message']);
    if (!WORKSPACE_ERROR_CODES.includes(value.error.code)) invalid();
    requireText(value.error.message, 2_048);
  } else invalid();
  if (value.version !== 1 || value.requestId !== expectedRequestId) invalid();
  return value;
}
function validatePlugins(plugins) {
  if (!Array.isArray(plugins) || plugins.length > WORKSPACE_LIMITS.plugins) invalid();
  const ids = new Set();
  for (const plugin of plugins) {
    exactObject(plugin, ['manifest', 'artifactSha256', 'commands'], ['licenseText']); requireSha256(plugin.artifactSha256);
    let manifest;
    try { manifest = parseManifest(plugin.manifest); } catch { invalid(); }
    if (manifest.protocolVersion !== 1 || !manifest.supportedHosts.includes('workspace-host') || manifest.manifestVersion !== 2 || manifest.runtime !== 'workspace') invalid();
    const id = manifest.id; if (ids.has(id)) invalid(); ids.add(id);
    if (!Array.isArray(plugin.commands) || plugin.commands.length > 64) invalid();
    const commandIds = new Set();
    for (const command of plugin.commands) {
      exactObject(command, ['pluginId', 'id', 'title'], ['description', 'parameters']);
      if (command.pluginId !== id || commandIds.has(command.id)) invalid();
      const {pluginId: _, ...definition} = command;
      try { parseCommandDefinition(definition); } catch { invalid(); }
      commandIds.add(command.id);
    }
    if (plugin.licenseText !== undefined && (typeof plugin.licenseText !== 'string' || encoder.encode(plugin.licenseText).length > 65_536)) invalid();
  }
}
export function parseWorkspaceHello(value) {
  value = wireInput(value);
  exactObject(value, ['hostId', 'hostVersion', 'protocolVersion', 'workspace', 'capabilities', 'plugins', 'notice']);
  requireText(value.hostId); requireText(value.hostVersion, 64); if (value.protocolVersion !== 1) invalid();
  exactObject(value.workspace, ['id', 'name', 'generation']); requireUuid(value.workspace.id); requireUuid(value.workspace.generation); requireText(value.workspace.name, 128);
  exactObject(value.capabilities, ['read', 'write', 'commands', 'manage']);
  if (value.capabilities.read !== true || Object.values(value.capabilities).some(v => typeof v !== 'boolean')) invalid();
  validatePlugins(value.plugins);
  exactObject(value.notice, ['id', 'version', 'sha256', 'text']); requireText(value.notice.id); requireText(value.notice.version, 64); requireSha256(value.notice.sha256);
  if (typeof value.notice.text !== 'string' || !value.notice.text || encoder.encode(value.notice.text).length > 65_536) invalid();
  return value;
}
export function parseWorkspaceMethodResult(method, value) {
  value = wireInput(value);
  if (method === 'hello') return parseWorkspaceHello(value);
  if (method.startsWith('artifacts.')) {
    try {
      if (method === 'artifacts.capabilities') return parseBinaryArtifactCapabilities(value);
      if (method === 'artifacts.list') return parseBinaryArtifactList(value);
      if (method === 'artifacts.read') return parseBinaryArtifactChunk(value);
    } catch {invalid();}
    invalid();
  }
  if (method.startsWith('jobs.')) {
    try {
      if (method === 'jobs.capabilities') return parseJobCapabilities(value);
      if (method === 'jobs.events') return parseJobEvents(value);
      if (method === 'jobs.artifact') return parseJobArtifactContent(value);
      if (['jobs.start', 'jobs.get', 'jobs.cancel'].includes(method)) return parseJobSnapshot(value);
    } catch {invalid();}
    invalid();
  }
  if (method === 'fs.list') {
    exactObject(value, ['entries']);
    if (!Array.isArray(value.entries) || value.entries.length > WORKSPACE_LIMITS.entries) invalid();
    const paths = new Set();
    for (const entry of value.entries) {
      exactObject(entry, ['path', 'name', 'kind'], ['size', 'revision']); requireWorkspacePath(entry.path); requireText(entry.name, 255);
      if (entry.path.split('/').at(-1) !== entry.name || paths.has(entry.path) || !['file', 'directory'].includes(entry.kind)) invalid(); paths.add(entry.path);
      if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) invalid();
      if (entry.revision !== undefined) requireSha256(entry.revision);
    }
  } else if (method === 'fs.read') { exactObject(value, ['path', 'content', 'revision']); requireWorkspacePath(value.path); requireFileContent(value.content); requireSha256(value.revision); }
  else if (method === 'fs.capabilities') {
    exactObject(value, ['protocolVersion', 'revision', 'conditionalRead']);
    if (value.protocolVersion !== 1 || typeof value.revision !== 'boolean' || typeof value.conditionalRead !== 'boolean') invalid();
  }
  else if (method === 'fs.readIfChanged') {
    if (value?.notModified === true) exactObject(value, ['path', 'revision', 'notModified']);
    else if (value?.notModified === false) {exactObject(value, ['path', 'revision', 'notModified', 'content']); requireFileContent(value.content);}
    else invalid();
    requireWorkspacePath(value.path); requireSha256(value.revision);
  }
  else if (method === 'fs.write' || method === 'fs.revision') { exactObject(value, ['path', 'revision']); requireWorkspacePath(value.path); requireSha256(value.revision); }
  else if (method === 'fs.rename') { exactObject(value, ['path', 'newPath']); requireWorkspacePath(value.path); requireWorkspacePath(value.newPath); }
  else if (method === 'fs.mkdir' || method === 'fs.remove') { exactObject(value, ['path']); requireWorkspacePath(value.path); }
  else if (method === 'request.cancel') { exactObject(value, ['cancelled']); if (typeof value.cancelled !== 'boolean') invalid(); }
  else if (method === 'plugins.list') { exactObject(value, ['plugins']); validatePlugins(value.plugins); }
  else if (method === 'commands.run') return copyWorkspaceJson(value);
  else invalid();
  return value;
}
