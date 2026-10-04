import {createPluginHost, definePlugin, parseCommandInput, parseCommandOutput, type CommandDefinition, type PluginManifestV2} from '@altifigence/dds-plugin-sdk';
import {parseDataSchema, validateDataValue, collectSecretReferences, describeDataForm, type DataSchema, type SecretReference} from '@altifigence/dds-plugin-sdk/data-schema';
import {createSettingsStore, parseSettingsSnapshot, type SettingsDefinition} from '@altifigence/dds-plugin-sdk/settings';
import {createSecretResolver, createSecretExecution} from '@altifigence/dds-plugin-sdk/secrets';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';
const schema: DataSchema = {schemaVersion: 1, schema: {type: 'object', additionalProperties: false, properties: {token: {type: 'object', format: 'dds-secret-reference'}}, required: ['token']}};
const definition: SettingsDefinition = {schemaVersion: 1, pluginId: 'example', version: 1, settings: {token: {schema: {schemaVersion: 1, schema: {type: 'object', format: 'dds-secret-reference'}}, scopes: ['workspace']}}};
const resolver = createSecretResolver({authorize: () => true, resolve: (_request, {signal}) => {signal.throwIfAborted(); return new Uint8Array([1]);}});
const reference: SecretReference = resolver.issue({secretId: 'operator-value', pluginId: 'example', workspaceId: 'workspace', commandIds: ['run']});
const store = createSettingsStore(definition);
store.update({workspaceId: 'workspace', scope: 'workspace', expectedRevision: 0, values: {token: reference}});
const snapshot = parseSettingsSnapshot(store.read('workspace')); const count: number = snapshot.revision;
await store.migrate({...definition, version: 2}, (before, {signal}) => {signal.throwIfAborted(); return {user: before.user, workspaces: before.workspaces};}, {expectedRevision: count});
const lease = createSecretExecution(resolver, {pluginId: 'example', workspaceId: 'workspace', commandId: 'run', executionId: crypto.randomUUID()}, [reference]);
await lease.secrets.withSecret(reference, (bytes, {signal}) => {const value: number = bytes.byteLength; signal.throwIfAborted(); void value;}); lease.dispose();
const pluginManifest: PluginManifestV2 = {manifestVersion: 2, id: 'example', name: 'Example', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', capabilities: ['settings'], permissions: ['settings.read'], supportedHosts: ['test-host'], license: 'MIT', source: {visibility: 'open', licenseFile: 'LICENSE'}};
const host = createPluginHost({settings: {example: store}, grants: ['settings.read']});
const command: CommandDefinition = {id: 'run', title: 'Run', inputSchema: schema, outputSchema: {schemaVersion: 1, schema: {type: 'boolean'}}, display: {labelKey: 'command.title'}};
const configured = createPluginHost({settings: {example: store}, secrets: resolver, grants: ['settings.read', 'secrets.resolve']});
void parseCommandInput({token: reference}, command); void parseCommandOutput(true, command); configured.dispose();
await host.activate(definePlugin(pluginManifest, context => {
  context.registerCommand(command, async (input, {secrets}) => {if (secrets) await secrets.withSecret(reference, bytes => {void bytes.byteLength;}); return input;});
  context.settings.subscribe(view => {const value: number = view.revision; void value;});
  // @ts-expect-error Plugin settings access does not confer write authority.
  context.settings.update({});
}));
// @ts-expect-error Object schemas are closed.
const openSchema: DataSchema = {schemaVersion: 1, schema: {type: 'object', properties: {}, additionalProperties: true}};
// @ts-expect-error Secret values are bytes supplied only by the resolver, not strings.
createSecretResolver({authorize: () => true, resolve: () => 'inline-secret'});
// @ts-expect-error CAS revision is mandatory.
store.update({workspaceId: 'workspace', scope: 'workspace', values: {}});
// @ts-expect-error A scope cannot be omitted or inferred from a reference ID.
resolver.withSecret(reference, () => {});
void validateDataValue; void collectSecretReferences; void describeDataForm; void parseDataSchema; void openSchema;
void SCHEMAS['data-schema']; void SCHEMAS['settings-snapshot']; void SCHEMAS['semantic-tokens']; host.dispose(); store.dispose(); resolver.dispose();
