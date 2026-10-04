import {parseSecretReference, configurationCopy as copy, configurationObject as object, configurationInteger as integer, configurationText as text, configurationPluginId, configurationMethod, configurationFailure as fail} from './configuration-values.mjs';
import {createConfigurationOperations, configurationOptions, configurationError as error} from './configuration-operations.mjs';
import {ErrorCode} from './limits.mjs';

export {parseSecretReference} from './configuration-values.mjs';
export const SECRET_LIMITS = Object.freeze({references: 128, commands: 32, pending: 8, valueBytes: 16_384, defaultTtlMs: 60_000, maxTtlMs: 3_600_000});
const typedArrayBytes = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
function copySecretBytes(material) {
  try {
    if (!(material instanceof Uint8Array)) throw new Error();
    const length = typedArrayBytes.call(material);
    if (length < 1 || length > SECRET_LIMITS.valueBytes) throw new Error();
    const bytes = new Uint8Array(length); Uint8Array.prototype.set.call(bytes, material); return bytes;
  } catch {throw error(ErrorCode.INVALID_CONTRACT);}
}
function scope(input) {
  const value = copy(input, 2048);
  object(value, ['pluginId', 'workspaceId', 'commandId', 'executionId']);
  configurationPluginId(value.pluginId); configurationPluginId(value.commandId); text(value.workspaceId, 128);
  if (typeof value.executionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.executionId)) fail('execution_id');
  return value;
}

/** Host-owned references. The provider keeps actual values outside settings and metadata. */
export function createSecretResolver(options) {
  object(options, ['resolve', 'authorize'], ['now']);
  if (typeof options.resolve !== 'function' || typeof options.authorize !== 'function' || options.now !== undefined && typeof options.now !== 'function') fail('secret_port');
  const {resolve, authorize, now = Date.now} = options;
  const records = new Map(), operations = createConfigurationOperations(SECRET_LIMITS.pending); let closed = false;
  const open = () => {if (closed) throw error(ErrorCode.DISPOSED);};
  const time = () => {let value; try {value = now();} catch {throw error(ErrorCode.PROVIDER_FAILED);} return integer(value, Number.MAX_SAFE_INTEGER - SECRET_LIMITS.maxTtlMs);};
  function retire(entry) {entry.revoked = true; records.delete(entry.reference.id); operations.abort(entry);}
  function prune() {const current = time(); for (const entry of records.values()) if (entry.expiresAt <= current) retire(entry);}
  function check(entry, execution, signal) {
    open(); if (signal?.aborted) throw signal.reason;
    if (!entry || entry.revoked || entry.expiresAt <= time() || records.get(entry.reference.id) !== entry || entry.pluginId !== execution.pluginId || entry.workspaceId !== execution.workspaceId || !entry.commandIds.includes(execution.commandId)) throw error(ErrorCode.PERMISSION_DENIED);
    let permitted;
    try {permitted = authorize(Object.freeze({...execution, reference: entry.reference, expiresAt: entry.expiresAt}));}
    catch {throw error(ErrorCode.PERMISSION_DENIED);}
    if (permitted !== true) throw error(ErrorCode.PERMISSION_DENIED);
  }
  return Object.freeze({
    issue(input) {
      open(); prune(); const value = copy(input, 8192);
      object(value, ['secretId', 'pluginId', 'workspaceId', 'commandIds'], ['ttlMs']);
      text(value.secretId, 128); configurationPluginId(value.pluginId); text(value.workspaceId, 128);
      if (!Array.isArray(value.commandIds) || value.commandIds.length < 1 || value.commandIds.length > SECRET_LIMITS.commands || new Set(value.commandIds).size !== value.commandIds.length) fail('commands');
      value.commandIds.forEach(name => configurationPluginId(name));
      const ttlMs = integer(value.ttlMs ?? SECRET_LIMITS.defaultTtlMs, SECRET_LIMITS.maxTtlMs, 1);
      if (records.size >= SECRET_LIMITS.references) throw error(ErrorCode.BUDGET_EXCEEDED);
      const reference = parseSecretReference({kind: 'dds-secret-reference', id: globalThis.crypto.randomUUID()});
      records.set(reference.id, {...value, reference, expiresAt: time() + ttlMs, revoked: false});
      return reference;
    },
    async withSecret(input, executionInput, callback, requestOptions = {}) {
      open(); prune(); const reference = parseSecretReference(input), execution = scope(executionInput), entry = records.get(reference.id);
      if (typeof callback !== 'function') fail('secret_callback');
      check(entry, execution);
      return operations.run(async signal => {
        let bytes;
        const erase = () => {bytes?.fill(0);};
        signal.addEventListener('abort', erase, {once: true});
        try {
          check(entry, execution, signal);
          let material;
          try {material = await resolve(Object.freeze({secretId: entry.secretId, reference, scope: execution, expiresAt: entry.expiresAt}), Object.freeze({signal}));}
          catch {if (signal.aborted) throw signal.reason; throw error(ErrorCode.PROVIDER_FAILED);}
          // Copy provider-owned bytes; clear the SDK-owned copy at every exit.
          bytes = copySecretBytes(material); material = undefined;
          check(entry, execution, signal);
          let result;
          try {result = await callback(bytes, Object.freeze({signal}));}
          catch {if (signal.aborted) throw signal.reason; throw error(ErrorCode.PROVIDER_FAILED);}
          check(entry, execution, signal);
          if (result !== undefined) throw error(ErrorCode.INVALID_CONTRACT);
        } finally {erase(); signal.removeEventListener('abort', erase);}
      }, requestOptions, {tag: entry, expiresIn: entry.expiresAt - time()});
    },
    revoke(input) {open(); const reference = parseSecretReference(input), entry = records.get(reference.id); if (!entry) return false; retire(entry); return true;},
    inspect() {open(); prune(); return Object.freeze({references: records.size, pending: operations.pending});},
    dispose() {if (closed) return; closed = true; for (const entry of records.values()) entry.revoked = true; records.clear(); operations.dispose();},
  });
}

/** An independent host binds only reviewed input references to one execution. */
export function createSecretExecution(resolver, executionInput, references, options = {}) {
  if (!resolver || typeof resolver !== 'object') fail('secret_port');
  const withSecret = configurationMethod(resolver, 'withSecret', true);
  const execution = scope(executionInput), allowed = new Set();
  if (!Array.isArray(references) || references.length > SECRET_LIMITS.references) fail('references');
  for (const reference of references) allowed.add(parseSecretReference(reference).id);
  object(options, [], ['signal']);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('signal');
  const controller = new AbortController(); let closed = false;
  const parentAbort = () => controller.abort(error(ErrorCode.CANCELLED));
  options.signal?.addEventListener('abort', parentAbort, {once: true});
  if (options.signal?.aborted) parentAbort();
  const api = Object.freeze({withSecret(reference, callback, requestOptions = {}) {
    const result = Promise.resolve().then(async () => {
      if (closed) throw error(ErrorCode.DISPOSED);
      if (controller.signal.aborted) throw controller.signal.reason;
      const checked = parseSecretReference(reference);
      if (!allowed.has(checked.id)) throw error(ErrorCode.PERMISSION_DENIED);
      const request = configurationOptions(requestOptions);
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
      try {await withSecret(checked, execution, callback, {...request, signal});}
      catch (failure) {
        const code = failure && typeof failure === 'object' ? Object.getOwnPropertyDescriptor(failure, 'code')?.value : undefined;
        throw error(Object.values(ErrorCode).includes(code) ? code : ErrorCode.PROVIDER_FAILED);
      }
      if (closed) throw error(ErrorCode.DISPOSED);
      if (signal.aborted) throw error(ErrorCode.CANCELLED);
    });
    // A host can close while a misbehaving plugin neglects to await its lease.
    result.catch(() => {});
    return result;
  }});
  return Object.freeze({scope: execution, secrets: api, dispose() {if (closed) return; closed = true; options.signal?.removeEventListener('abort', parentAbort); controller.abort(error(ErrorCode.DISPOSED)); allowed.clear();}});
}
