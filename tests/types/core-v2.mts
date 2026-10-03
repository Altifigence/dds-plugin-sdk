import { createPluginHost, definePlugin, parseJsonValue, type PluginManifestV2, type WorkspacePort, type BackendHandler } from '@altifigence/dds-plugin-sdk';

const manifest: PluginManifestV2 = {
  manifestVersion: 2, id: 'typed-command', name: 'Typed Command', publisher: 'example', version: '0.2.0',
  protocolVersion: 1, entry: './plugin.mjs', runtime: 'workspace', capabilities: ['commands'],
  permissions: ['workspace.read', 'workspace.write', 'backend.invoke'], supportedHosts: ['workspace-host'],
  license: 'MIT OR LicenseRef-Custom', source: {visibility: 'open', repository: 'https://github.com/example/plugin', licenseFile: 'LICENSE'},
};
const workspace: WorkspacePort = {
  readFile: path => ({path, content: 'hello', revision: 'one'}),
  writeFile: (path, content, {expectedRevision, signal}) => {
    signal.throwIfAborted(); void content; void expectedRevision;
    return {path, revision: 'two'};
  },
  listFiles: () => [{path: 'hello.txt', name: 'hello.txt', kind: 'file', size: 5}],
};
const backend: BackendHandler = (input, {scope, pluginId, signal}) => {
  signal.throwIfAborted(); void scope; void pluginId;
  return {output: input};
};
const host = createPluginHost({hostId: 'workspace-host', grants: manifest.permissions, workspace, backends: {lint: backend}});
await host.activate(definePlugin(manifest, context => context.registerCommand({id: 'lint', title: 'Lint'}, async (_, {signal}) => {
  const file = await context.workspace.readFile('hello.txt', {signal});
  const saved = await context.workspace.writeFile(file.path, file.content, {expectedRevision: file.revision, signal});
  return context.backends.invoke('lint', {revision: saved.revision}, {signal});
})));
const commands = host.listCommands();
commands.forEach(command => console.log(command.pluginId, command.id));
host.listPlugins().forEach(value => {if (value.manifestVersion === 2) console.log(value.source.visibility, value.runtime);});
await host.executeCommand(manifest.id, 'lint', parseJsonValue({}));
host.dispose();
// @ts-expect-error non-JSON values cannot be a command result
definePlugin(manifest, context => context.registerCommand({id: 'invalid', title: 'Invalid'}, () => undefined));
