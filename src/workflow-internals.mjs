import {canonical, clone, digest, fail, fields, sha, string} from './release-internals.mjs';
export {canonical, clone, digest, fail, fields, sha, string};
export function integer(value, min, max) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID', 'Integer outside supported range'); return value; }
export function identifier(value) { string(value, 'identifier', 128); if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) fail('INVALID', 'Invalid identifier'); return value; }
export function scope(value) { fields(value, ['workspaceId', 'securityScope']); identifier(value.workspaceId); identifier(value.securityScope); return value; }
export function strings(value, max = 64) { if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length) fail('INVALID', 'Expected unique bounded strings'); value.forEach(identifier); return value; }
export function immutable(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(immutable); Object.freeze(value); } return value; }
export function jsonCopy(value, bytes = 65_536) { return immutable(JSON.parse(canonical(value, bytes))); }
export function aborted(signal) { if (signal?.aborted) fail(signal.reason?.code === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED', 'Operation stopped'); }
export function deadline(parent, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  if (parent?.aborted) onAbort(); else parent?.addEventListener('abort', onAbort, {once:true});
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Deadline exceeded'), {code:'TIMEOUT'})), timeoutMs);
  return {controller, signal:controller.signal, close() {clearTimeout(timer); parent?.removeEventListener('abort', onAbort);}};
}
export async function interruptible(promise, signal) {
  aborted(signal); let cancel;
  try { return await Promise.race([promise, new Promise((_, reject) => {cancel = () => reject(Object.assign(new Error('Operation stopped'), {code:signal.reason?.code === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'})); signal.addEventListener('abort', cancel, {once:true}); if (signal.aborted) cancel();})]); }
  finally {signal.removeEventListener('abort', cancel);}
}
export async function authorized(authorize, context, signal) { aborted(signal); if (await interruptible(Promise.resolve().then(() => authorize(immutable(clone(context)))), signal) !== true) fail('DENIED', 'Current operator authorization required'); aborted(signal); }
export function errorCode(error) { return typeof error?.code === 'string' && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : 'FAILED'; }
export const pause = (milliseconds, signal) => new Promise((resolve, reject) => {
  const done = () => {clearTimeout(timer); signal?.removeEventListener('abort', cancel);};
  const cancel = () => {done(); reject(Object.assign(new Error('Stopped'), {code:'CANCELLED'}));};
  const timer = setTimeout(() => {done(); resolve();}, milliseconds);
  signal?.addEventListener('abort', cancel, {once:true}); if (signal?.aborted) cancel();
});
