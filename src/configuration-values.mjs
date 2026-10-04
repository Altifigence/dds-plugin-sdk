import {copyWorkspaceJson, exactObject, WorkspaceError} from './workspace-values.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';

/** A path and a stable reason, never the rejected value or a provider's message. */
export class DataValidationError extends PluginSdkError {
  constructor(reason, path = '', budget = false) {
    super(budget ? ErrorCode.BUDGET_EXCEEDED : ErrorCode.INVALID_CONTRACT, `Data validation failed (${reason}) at ${path || '/'}`);
    this.name = 'DataValidationError'; this.reason = reason; this.path = path;
  }
}
export function configurationFailure(reason, path = '', budget = false) {throw new DataValidationError(reason, path, budget);}
export function configurationCopy(value, maxBytes = 65_536,maxNodes=10_000) {
  try {return copyWorkspaceJson(value, {maxBytes, maxDepth: 32, maxNodes});}
  catch (error) {configurationFailure(error instanceof WorkspaceError && error.code === 'budget_exceeded' ? 'budget' : 'invalid_json', '', error instanceof WorkspaceError && error.code === 'budget_exceeded');}
}
export function configurationObject(value, required, optional = [], path = '') {
  try {exactObject(value, required, optional);}
  catch {configurationFailure('unsupported_field', path);}
  return value;
}
/** Capture data methods, including class prototypes, without invoking getters. */
export function configurationMethod(port, name, required = false) {
  let current = port;
  for (let depth = 0; current && depth < 16; depth++, current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') configurationFailure('port_method');
      return (...args) => descriptor.value.call(port, ...args);
    }
  }
  if (required) configurationFailure('port_method');
}
export function configurationText(value, maximum, path = '', minimum = 1) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length < minimum || value.length > maximum || value.includes('\0')) configurationFailure('text', path);
  return value;
}
export function configurationKey(value, path = '') {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value) || ['constructor', 'prototype', '__proto__'].includes(value)) configurationFailure('identifier', path);
  return value;
}
export function configurationPluginId(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)) configurationFailure('plugin_id');
  return value;
}
export function configurationInteger(value, maximum, minimum = 0, path = '') {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) configurationFailure('integer', path);
  return value;
}
export function freezeConfiguration(value) {
  if (value && typeof value === 'object') {for (const item of Object.values(value)) freezeConfiguration(item); Object.freeze(value);}
  return value;
}
export function displayMetadata(value, path = '') {
  configurationObject(value, [], ['label', 'help', 'order', 'labelKey', 'helpKey', 'accessibility'], path);
  for (const key of ['label', 'help']) if (Object.hasOwn(value, key)) configurationText(value[key], key === 'help' ? 2048 : 256, `${path}/${key}`);
  for (const key of ['labelKey', 'helpKey']) if (Object.hasOwn(value, key)) configurationKey(value[key], `${path}/${key}`);
  if (Object.hasOwn(value, 'order')) configurationInteger(value.order, 10_000, 0, `${path}/order`);
  if (Object.hasOwn(value, 'accessibility')) {
    const a = value.accessibility;
    configurationObject(a, [], ['name', 'description', 'nameKey', 'descriptionKey', 'shortcut'], `${path}/accessibility`);
    for (const key of ['name', 'description', 'shortcut']) if (Object.hasOwn(a, key)) configurationText(a[key], key === 'description' ? 2048 : 256, `${path}/accessibility/${key}`);
    for (const key of ['nameKey', 'descriptionKey']) if (Object.hasOwn(a, key)) configurationKey(a[key], `${path}/accessibility/${key}`);
  }
  return value;
}
export function parseDisplayMetadata(value) {return displayMetadata(configurationCopy(value, 8192));}

export function parseSecretReference(value) {
  value = configurationCopy(value, 256);
  configurationObject(value, ['kind', 'id']);
  if (value.kind !== 'dds-secret-reference' || typeof value.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id)) configurationFailure('secret_reference');
  return value;
}
