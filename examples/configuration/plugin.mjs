import {definePlugin} from '@altifigence/dds-plugin-sdk';

const data = schema => ({schemaVersion: 1, schema});
export const settingsDefinition = {schemaVersion: 1, pluginId: 'configuration-example', version: 1, settings: {
  multiplier: {schema: data({type: 'integer', minimum: 1, maximum: 10, default: 2}), scopes: ['user', 'workspace'], display: {label: 'Multiplier', labelKey: 'settings.multiplier', helpKey: 'settings.help', accessibility: {nameKey: 'settings.multiplier'}}},
  token: {schema: data({type: 'object', format: 'dds-secret-reference'}), scopes: ['workspace'], display: {label: 'Execution reference', labelKey: 'settings.token'}},
  format: {schema: data({type: 'string', default: 'summary-v1'}), scopes: [], readOnly: true, display: {label: 'Result format', labelKey: 'settings.format'}},
}};
export const command = {id: 'summarize', title: 'Summarize', display: {labelKey: 'command.title', helpKey: 'command.help', accessibility: {nameKey: 'command.title', descriptionKey: 'command.help', shortcut: 'Control+Enter'}}, inputSchema: data({
  type: 'object', additionalProperties: false, properties: {
    options: {type: 'object', additionalProperties: false, properties: {
      names: {type: 'array', items: {type: 'string', minLength: 1, maxLength: 64}, minItems: 1, maxItems: 8, display: {labelKey: 'input.names', helpKey: 'input.help'}},
      mode: {type: 'string', enum: ['short', 'detailed'], default: 'short', display: {labelKey: 'input.mode'}},
    }, required: ['names', 'mode']},
    token: {type: 'object', format: 'dds-secret-reference', display: {labelKey: 'settings.token'}},
  }, required: ['options', 'token'],
}), outputSchema: data({type: 'object', additionalProperties: false, properties: {
  count: {type: 'integer', minimum: 1}, total: {type: 'integer', minimum: 1}, mode: {type: 'string', enum: ['short', 'detailed']}, authorized: {type: 'boolean'},
}, required: ['count', 'total', 'mode', 'authorized']})};

export function createConfigurationPlugin({onStart = () => {}} = {}) {
  return definePlugin({manifestVersion: 2, id: 'configuration-example', name: 'Configuration Example', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'workspace', capabilities: ['commands', 'settings'], permissions: ['settings.read', 'secrets.resolve'], supportedHosts: ['workspace-host'], license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'}, display: {labelKey: 'plugin.name'}}, context => context.registerCommand(command, async (input, {signal, secrets, job}) => {
    await onStart({signal}); signal.throwIfAborted();
    const view = await context.settings.read({signal}); let authorized = false;
    await secrets.withSecret(input.token, bytes => {authorized = bytes.byteLength > 0;}, {signal});
    job?.reportProgress({completed: 1, total: 1});
    return {count: input.options.names.length, total: input.options.names.length * view.values.multiplier, mode: input.options.mode, authorized};
  }));
}
