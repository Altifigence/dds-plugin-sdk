import {isPrivateFileComponent,isSafeWorkspaceRelativePath} from './patterns.mjs';
export const WORKSPACE_LIMITS = Object.freeze({wireBytes: 1_600_000, fileBytes: 262_144, jsonBytes: 262_144, depth: 16, nodes: 10_000, entries: 1_000, plugins: 32, pending: 64, receiving: 16, connections: 128, defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000});
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
