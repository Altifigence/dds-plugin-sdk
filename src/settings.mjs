import {parseDataSchema, validateDataValue} from './data-schema.mjs';
import {configurationCopy as copy, configurationFailure as fail, configurationObject as object, configurationInteger as integer, configurationText as text, configurationKey as key, configurationPluginId, displayMetadata, freezeConfiguration} from './configuration-values.mjs';
import {createConfigurationOperations, configurationError as error} from './configuration-operations.mjs';
import {ErrorCode} from './limits.mjs';

export const SETTINGS_LIMITS = Object.freeze({definitionBytes: 65_536, keys: 64, layerBytes: 65_536, snapshotBytes: 262_144, stateBytes: 1_048_576, workspaces: 32, subscriptions: 64, pendingMigrations: 1});
const definitions = new WeakSet();
const own = (value, name) => Object.hasOwn(value, name);
const canonical = value => JSON.stringify(value, (_name, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
function workspaceId(value) {text(value, 128); if (/[\u0000-\u001f\u007f]/u.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) fail('workspace_id'); return value;}

export function parseSettingsDefinition(input) {
  if (definitions.has(input)) return input;
  const value = copy(input, SETTINGS_LIMITS.definitionBytes);
  object(value, ['schemaVersion', 'pluginId', 'version', 'settings']);
  if (value.schemaVersion !== 1) fail('schema_version');
  configurationPluginId(value.pluginId); integer(value.version, Number.MAX_SAFE_INTEGER, 1);
  if (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) fail('settings');
  const names = Object.keys(value.settings);
  if (names.length > SETTINGS_LIMITS.keys) fail('budget', '/settings', true);
  for (const name of names) {
    key(name, '/settings');
    const item = value.settings[name], path = `/settings/${name}`;
    object(item, ['schema', 'scopes'], ['readOnly', 'display'], path);
    parseDataSchema(item.schema);
    if (!Array.isArray(item.scopes) || item.scopes.length > 2 || new Set(item.scopes).size !== item.scopes.length || item.scopes.some(scope => !['user', 'workspace'].includes(scope))) fail('scopes', path);
    if (own(item, 'readOnly') && typeof item.readOnly !== 'boolean') fail('read_only', path);
    if (item.readOnly ? item.scopes.length !== 0 || !own(item.schema.schema, 'default') : item.scopes.length === 0) fail('scopes', path);
    if (own(item, 'display')) displayMetadata(item.display, `${path}/display`);
  }
  definitions.add(value);
  return value;
}

function layer(input, definition, scope) {
  const value = copy(input, SETTINGS_LIMITS.layerBytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('settings_layer');
  if (Object.keys(value).some(name => !own(definition.settings, name))) fail('unknown_setting');
  const output = {};
  for (const [name, item] of Object.entries(definition.settings)) if (own(value, name)) {
    if (item.readOnly || !item.scopes.includes(scope)) throw error(ErrorCode.PERMISSION_DENIED);
    output[name] = validateDataValue(item.schema, value[name], {applyDefaults: true});
  }
  return copy(output, SETTINGS_LIMITS.layerBytes);
}
function layers(input, definition) {
  const value = copy(input, SETTINGS_LIMITS.stateBytes);
  object(value, ['user', 'workspaces']);
  if (!value.workspaces || typeof value.workspaces !== 'object' || Array.isArray(value.workspaces)) fail('workspaces');
  if (Object.keys(value.workspaces).length > SETTINGS_LIMITS.workspaces) fail('budget', '/workspaces', true);
  const workspaces = {};
  for (const name of Object.keys(value.workspaces).sort()) workspaces[workspaceId(name)] = layer(value.workspaces[name], definition, 'workspace');
  return copy({user: layer(value.user, definition, 'user'), workspaces}, SETTINGS_LIMITS.stateBytes);
}

export function parseSettingsSnapshot(input) {
  const value = copy(input, SETTINGS_LIMITS.snapshotBytes);
  object(value, ['schemaVersion', 'pluginId', 'workspaceId', 'definitionVersion', 'revision', 'values', 'sources']);
  if (value.schemaVersion !== 1) fail('schema_version');
  configurationPluginId(value.pluginId); workspaceId(value.workspaceId);
  integer(value.definitionVersion, Number.MAX_SAFE_INTEGER, 1); integer(value.revision, Number.MAX_SAFE_INTEGER);
  for (const name of ['values', 'sources']) if (!value[name] || typeof value[name] !== 'object' || Array.isArray(value[name]) || Object.keys(value[name]).length > SETTINGS_LIMITS.keys) fail('settings_snapshot');
  if (Object.keys(value.values).length !== Object.keys(value.sources).length) fail('settings_sources');
  for (const name of Object.keys(value.values)) {key(name); if (!own(value.sources, name) || !['default', 'user', 'workspace'].includes(value.sources[name])) fail('settings_sources');}
  return value;
}

/** One plugin's operator-owned in-memory settings. The owner retains write authority. */
export function createSettingsStore(input, options = {}) {
  object(options, [], ['state']);
  let definition = parseSettingsDefinition(input), revision = 0, closed = false, queued = false;
  let values = layers({user: {}, workspaces: {}}, definition);
  if (options.state !== undefined) {
    const state = copy(options.state, SETTINGS_LIMITS.stateBytes);
    object(state, ['schemaVersion', 'pluginId', 'definitionVersion', 'revision', 'user', 'workspaces']);
    if (state.schemaVersion !== 1 || state.pluginId !== definition.pluginId || state.definitionVersion !== definition.version) throw error(ErrorCode.VERSION_MISMATCH);
    revision = integer(state.revision, Number.MAX_SAFE_INTEGER - 1);
    values = layers({user: state.user, workspaces: state.workspaces}, definition);
  }
  const subscribers = new Set(), operations = createConfigurationOperations(SETTINGS_LIMITS.pendingMigrations);
  function open() {if (closed) throw error(ErrorCode.DISPOSED);}
  function compare(expected) {integer(expected, Number.MAX_SAFE_INTEGER); if (expected !== revision) throw error(ErrorCode.CONFLICT);}
  function read(id) {
    open(); id = workspaceId(id);
    const result = {}, sources = {}, selected = values.workspaces[id] ?? {};
    for (const [name, item] of Object.entries(definition.settings)) {
      if (own(item.schema.schema, 'default')) {result[name] = validateDataValue(item.schema, item.schema.schema.default); sources[name] = 'default';}
      if (own(values.user, name)) {result[name] = values.user[name]; sources[name] = 'user';}
      if (own(selected, name)) {result[name] = selected[name]; sources[name] = 'workspace';}
    }
    return copy({schemaVersion: 1, pluginId: definition.pluginId, workspaceId: id, definitionVersion: definition.version, revision, values: result, sources}, SETTINGS_LIMITS.snapshotBytes);
  }
  function exportState() {open(); return copy({schemaVersion: 1, pluginId: definition.pluginId, definitionVersion: definition.version, revision, ...values}, SETTINGS_LIMITS.stateBytes);}
  function notify() {
    if (queued) return; queued = true;
    queueMicrotask(() => {
      queued = false; if (closed) return;
      for (const listener of [...subscribers]) {
        if (!subscribers.has(listener) || listener.revision === revision) continue;
        listener.revision = revision;
        try {Promise.resolve(listener.callback(read(listener.workspaceId))).catch(() => {});} catch { /* a subscriber cannot roll back or expose an error */ }
      }
    });
  }
  function commit(next, nextDefinition = definition) {
    if (revision >= Number.MAX_SAFE_INTEGER - 1) throw error(ErrorCode.BUDGET_EXCEEDED);
    copy({schemaVersion: 1, pluginId: nextDefinition.pluginId, definitionVersion: nextDefinition.version, revision: revision + 1, ...next}, SETTINGS_LIMITS.stateBytes);
    // Verify every possible effective view before committing any state.
    const oldValues = values, oldDefinition = definition;
    values = next; definition = nextDefinition;
    try {for (const id of ['settings-default-view', ...Object.keys(next.workspaces)]) read(id);}
    catch (failure) {values = oldValues; definition = oldDefinition; throw failure;}
    revision++; notify();
  }
  // Validate the aggregate default/user/workspace sizes at construction too.
  for (const id of ['settings-default-view', ...Object.keys(values.workspaces)]) read(id);
  return Object.freeze({
    get definition() {open(); return definition;},
    read,
    exportState,
    update(request) {
      open(); request = copy(request, SETTINGS_LIMITS.layerBytes + 4096);
      object(request, ['workspaceId', 'scope', 'expectedRevision'], ['values', 'reset']);
      const id = workspaceId(request.workspaceId); compare(request.expectedRevision);
      if (!['user', 'workspace'].includes(request.scope)) fail('scope');
      const changed = layer(request.values ?? {}, definition, request.scope), reset = request.reset ?? [];
      if (!Array.isArray(reset) || reset.length > SETTINGS_LIMITS.keys || new Set(reset).size !== reset.length) fail('reset');
      for (const name of reset) {
        key(name); if (!own(definition.settings, name)) fail('unknown_setting');
        const item = definition.settings[name];
        if (item.readOnly || !item.scopes.includes(request.scope)) throw error(ErrorCode.PERMISSION_DENIED);
        if (own(changed, name)) fail('reset_conflict');
      }
      const current = request.scope === 'user' ? values.user : values.workspaces[id] ?? {};
      const nextLayer = {...current, ...changed}; for (const name of reset) delete nextLayer[name];
      const workspaces = {...values.workspaces};
      if (request.scope === 'workspace') {if (Object.keys(nextLayer).length) workspaces[id] = nextLayer; else delete workspaces[id];}
      const next = layers({user: request.scope === 'user' ? nextLayer : values.user, workspaces}, definition);
      if (canonical(next) !== canonical(values)) commit(next);
      return read(id);
    },
    subscribe(id, callback) {
      open(); workspaceId(id);
      if (typeof callback !== 'function') fail('subscriber');
      if (subscribers.size >= SETTINGS_LIMITS.subscriptions) throw error(ErrorCode.BUDGET_EXCEEDED);
      const entry = {workspaceId: id, callback, revision}; subscribers.add(entry);
      return Object.freeze({dispose() {subscribers.delete(entry);}});
    },
    async migrate(nextInput, migration, options) {
      open(); object(options, ['expectedRevision'], ['signal', 'timeoutMs']); compare(options.expectedRevision);
      const expected = revision, before = exportState(), nextDefinition = parseSettingsDefinition(nextInput);
      if (nextDefinition.pluginId !== definition.pluginId || nextDefinition.version <= definition.version) throw error(ErrorCode.VERSION_MISMATCH);
      if (typeof migration !== 'function') fail('migration');
      return operations.run(async signal => {
        let proposed;
        try {proposed = await migration(before, Object.freeze({signal, definition: nextDefinition}));}
        catch {if (signal.aborted) throw signal.reason; throw error(ErrorCode.PROVIDER_FAILED);}
        open(); if (signal.aborted) throw signal.reason; compare(expected);
        const next = layers(proposed, nextDefinition);
        commit(next, nextDefinition);
        return exportState();
      }, {signal: options.signal, timeoutMs: options.timeoutMs});
    },
    inspect() {open(); return freezeConfiguration({revision, definitionVersion: definition.version, workspaces: Object.keys(values.workspaces).length, subscriptions: subscribers.size, pendingMigrations: operations.pending});},
    dispose() {if (closed) return; closed = true; subscribers.clear(); values = undefined; operations.dispose();},
  });
}
