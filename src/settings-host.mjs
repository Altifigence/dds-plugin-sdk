import {parseSettingsSnapshot, SETTINGS_LIMITS} from './settings.mjs';
import {configurationPluginId} from './configuration-values.mjs';
import {configurationError as error} from './configuration-operations.mjs';
import {ErrorCode, LIMITS} from './limits.mjs';

function method(port, name, required = false) {
  let object = port;
  for (let depth = 0; object && depth < 16; depth++, object = Object.getPrototypeOf(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') throw error(ErrorCode.INVALID_CONTRACT);
      return (...args) => descriptor.value.call(port, ...args);
    }
  }
  if (required) throw error(ErrorCode.INVALID_CONTRACT);
}
export function settingsPorts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw error(ErrorCode.INVALID_CONTRACT);
  const names = Reflect.ownKeys(input); if (names.length > LIMITS.maxRegistrations) throw error(ErrorCode.BUDGET_EXCEEDED);
  const ports = new Map();
  for (const name of names) {
    configurationPluginId(name);
    const descriptor = Object.getOwnPropertyDescriptor(input, name), port = descriptor?.value;
    if (!descriptor?.enumerable || !('value' in descriptor) || !port || typeof port !== 'object') throw error(ErrorCode.INVALID_CONTRACT);
    ports.set(name, {read: method(port, 'read', true), subscribe: method(port, 'subscribe')});
  }
  return ports;
}

export function createSettingsApi({pluginId, workspaceId, port, permit, run, registrations}) {
  let subscriptions = 0;
  const check = () => {permit(); if (!port) throw error(ErrorCode.CAPABILITY_UNAVAILABLE);};
  const validate = input => {
    const value = parseSettingsSnapshot(input);
    if (value.pluginId !== pluginId || value.workspaceId !== workspaceId) throw error(ErrorCode.PERMISSION_DENIED);
    return value;
  };
  return Object.freeze({
    async read(options = {}) {check(); const result = await run(signal => port.read(workspaceId, Object.freeze({signal})), options, validate); check(); return result;},
    subscribe(callback) {
      check(); if (typeof callback !== 'function') throw error(ErrorCode.INVALID_CONTRACT);
      if (!port.subscribe) throw error(ErrorCode.CAPABILITY_UNAVAILABLE);
      if (subscriptions >= SETTINGS_LIMITS.subscriptions) throw error(ErrorCode.BUDGET_EXCEEDED);
      let raw, active = true; subscriptions++;
      const registration = Object.freeze({dispose() {
        if (!active) return; active = false; subscriptions--; registrations.delete(registration);
        try {raw?.();} catch { /* port cleanup errors are private */ }
      }});
      registrations.add(registration);
      try {
        const result = port.subscribe(workspaceId, input => {
          if (!active) return;
          let value;
          try {check(); value = validate(input);} catch {registration.dispose(); return;}
          try {Promise.resolve(callback(value)).catch(() => {});} catch { /* isolated plugin listener */ }
        });
        if (!result || typeof result !== 'object') throw error(ErrorCode.INVALID_CONTRACT);
        raw = method(result, 'dispose', true);
        if (!active) raw();
      } catch {registration.dispose(); throw error(ErrorCode.PROVIDER_FAILED);}
      return registration;
    },
  });
}
