import {createPluginHost, definePlugin, type PluginManifestV2} from '@altifigence/dds-plugin-sdk';
import {parseTheme, serializeThemeXml} from '@altifigence/dds-plugin-sdk/themes';
import {validatePluginPackage, packPlugin} from '@altifigence/dds-plugin-sdk/publishing';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {createNodeWorkspace, createProcessBackend, createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createNotice, createPermissionGrant, isPermissionGranted} from '@altifigence/dds-plugin-sdk/consent';

const manifest: PluginManifestV2 = {
  manifestVersion: 2, id: 'typed-workspace', name: 'Typed Workspace', publisher: 'example', version: '1.0.0',
  protocolVersion: 1, entry: './plugin.mjs', runtime: 'workspace', capabilities: ['commands'],
  permissions: ['workspace.read', 'workspace.write', 'backend.invoke'], supportedHosts: ['workspace-host'],
  license: 'LicenseRef-Example-Proprietary', source: {visibility: 'closed', licenseFile: 'LICENSE'},
};
const plugin = definePlugin(manifest, context => context.registerCommand({id: 'save', title: 'Save'}, async (_, {signal}) => {
  const file = await context.workspace.readFile('example.txt', {signal});
  const result = await context.workspace.writeFile(file.path, 'updated', {expectedRevision: file.revision, signal});
  await context.backends.invoke('lint', {path: result.path}, {signal});
  return {revision: result.revision};
}));
const host = createPluginHost({hostId: 'workspace-host', grants: ['workspace.read']});
void host.activate(plugin);
void host.executeCommand(manifest.id, 'save', {});
// @ts-expect-error an expected revision is required for workspace saves
definePlugin(manifest, context => {void context.workspace.writeFile('example.txt', 'text', {});});
// @ts-expect-error shell execution is not an SDK permission
createPluginHost({grants: ['shell.execute']});

const palette = {backdrop: '#111111', navigation: '#222222', tool: '#333333', main: '#444444', text: '#ffffff', muted: '#aaaaaa'};
serializeThemeXml(parseTheme({name: 'Typed Theme', colors: {light: palette, dark: palette}}));
void validatePluginPackage('/operator/plugin');
void packPlugin('/operator/plugin', {out: '/operator/dist'});
const client = createWorkspaceClient({url: 'https://workspace.example.org', token: 'operator-supplied-at-runtime-token'});
void client.writeFile('example.txt', 'updated', 'a'.repeat(64));
// @ts-expect-error expectedRevision is mandatory on a remote write
void client.writeFile('example.txt', 'updated');
void createNodeWorkspace;
void createProcessBackend;
void createWorkspaceServer;
void createNotice({id: 'typed-notice', version: '1.0.0', locale: 'en', purpose: 'permission review', text: 'Read the selected project.'});
void createPermissionGrant;
void isPermissionGranted;
