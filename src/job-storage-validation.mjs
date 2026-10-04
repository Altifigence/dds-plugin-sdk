import {ErrorCode, PluginSdkError} from './limits.mjs';
const fail = () => {throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, 'Invalid job storage contract');};
export function storageObject(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.length > required.length + optional.length) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) fail();
  }
}
export function storageInteger(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}
export function storageSha(value) {if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value;}

// Only compare already validated, bounded plain data; JSON object order is not identity.
export function storageEqual(a,b) {
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&storageEqual(a[key],b[key]));
}
