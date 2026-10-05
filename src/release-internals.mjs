import {createHash} from 'node:crypto';
import {WINDOWS_DEVICE_COMPONENT, isPrivateFileComponent} from './patterns.mjs';

export const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function fields(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) fail('INVALID', 'Unexpected or missing fields');
  return value;
}
export function string(value, label = 'text', max = 1024) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || !value.isWellFormed() || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID', `Invalid ${label}`);
  return value;
}
export function sha(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('INVALID', 'Expected lowercase SHA-256'); return value; }
export function exactVersion(value) {
  if (typeof value !== 'string' || value.length > 96 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value)) fail('INVALID', 'Expected exact version');
  return value;
}
export function sourceUrl(value, allowLoopback = false) {
  string(value, 'source URL', 2048); let url;
  try { url = new URL(value); } catch { fail('INVALID', 'Invalid source URL'); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))) fail('INVALID', 'Expected an explicit HTTPS source URL');
  return url.href;
}
export function canonical(value, maxBytes = 64 * 1024 * 1024) {
  const seen = new Set(); let nodes = 0;
  const walk = (v, depth) => {
    if (++nodes > 100000 || depth > 32) fail('LIMIT', 'JSON structure limit exceeded');
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v === 'string' && v.isWellFormed() && v.length <= maxBytes) return JSON.stringify(v);
    if (!v || typeof v !== 'object' || seen.has(v)) fail('INVALID', 'Expected acyclic JSON data');
    seen.add(v); let result;
    if (Array.isArray(v)) {
      if (v.length > 10000 || Object.keys(v).length !== v.length) fail('LIMIT', 'Invalid JSON array');
      result = '[' + v.map(x => walk(x, depth + 1)).join(',') + ']';
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail('INVALID', 'Expected plain JSON object');
      const keys = Object.keys(v).sort();
      if (keys.length > 10000 || keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k) || !k.isWellFormed())) fail('INVALID', 'Invalid JSON keys');
      result = '{' + keys.map(k => {
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(v, k), 'value')) fail('INVALID', 'JSON accessors are unsupported');
        return JSON.stringify(k) + ':' + walk(v[k], depth + 1);
      }).join(',') + '}';
    }
    seen.delete(v); if (result.length > maxBytes) fail('LIMIT', 'JSON byte limit exceeded'); return result;
  };
  const result = walk(value, 0);
  if (Buffer.byteLength(result) > maxBytes) fail('LIMIT', 'JSON byte limit exceeded');
  return result;
}
export const clone = value => JSON.parse(canonical(value));
export function base64(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('INVALID', 'Invalid or oversized base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) fail('LIMIT', 'Invalid base64 content');
  return bytes;
}
export function portablePath(value) {
  string(value, 'file path', 180);
  if (/[^\x20-\x7e]|[\\:*?"<>|]/.test(value)) fail('INVALID', 'Expected portable relative path');
  const parts = value.split('/');
  if (parts.length > 12 || parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || WINDOWS_DEVICE_COMPONENT.test(p) || isPrivateFileComponent(p) || p.toLowerCase() === 'node_modules')) fail('INVALID', 'Unsupported file path');
  return value;
}
