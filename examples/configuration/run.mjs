import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {parseCommandInput, parseCommandOutput} from '@altifigence/dds-plugin-sdk';
import {createSettingsStore} from '@altifigence/dds-plugin-sdk/settings';
import {createSecretResolver} from '@altifigence/dds-plugin-sdk/secrets';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {validateLocalizedSurfaces, localizeDisplay, resolveMessage} from '@altifigence/dds-plugin-sdk/localization';
import {inspectAccessibility, inspectThemeContrast} from '@altifigence/dds-plugin-sdk/accessibility';
import {command, settingsDefinition, createConfigurationPlugin} from './plugin.mjs';
import {catalog, exampleTheme} from './catalog.mjs';

const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dds-configuration-example-'))), workspaceId = randomUUID();
const token = randomBytes(32).toString('hex'), privateMaterial = randomBytes(16), artifactSha256 = 'c'.repeat(64);
let allowed = true, executions = 0, server, client;
const store = createSettingsStore(settingsDefinition), notifications = [];
const resolver = createSecretResolver({authorize: () => allowed, resolve: () => privateMaterial});
const reference = resolver.issue({secretId: 'operator-example', pluginId: settingsDefinition.pluginId, workspaceId, commandIds: ['summarize']});
try {
  assert.equal(store.read(workspaceId).values.multiplier, 2);
  store.update({workspaceId, scope: 'user', expectedRevision: 0, values: {multiplier: 3}});
  const subscription = store.subscribe(workspaceId, view => notifications.push(view));
  store.update({workspaceId, scope: 'workspace', expectedRevision: 1, values: {multiplier: 4, token: reference}});
  await Promise.resolve(); assert.equal(notifications.at(-1).sources.multiplier, 'workspace');
  assert.equal(store.read(randomUUID()).values.multiplier, 3);
  assert.throws(() => store.update({workspaceId, scope: 'workspace', expectedRevision: 1, values: {multiplier: 9}}), error => error.code === 'conflict');
  const plugin = createConfigurationPlugin({onStart: () => executions++});
  const surfaces = validateLocalizedSurfaces(catalog, {manifest: plugin.manifest, commands: [command], settings: settingsDefinition, themes: [{theme: exampleTheme, display: {labelKey: 'theme.name'}}]});
  assert.equal(surfaces.missingTranslations.some(item => ['en', 'ko'].includes(item.locale)), false);
  assert.equal(resolveMessage(catalog, 'ar', 'command.help').locale, 'en'); assert.equal(resolveMessage(catalog, 'ar', 'command.title').direction, 'rtl');
  const localized = localizeDisplay(catalog, 'ko', command.display); assert.equal(localized.label, '요약 실행'); assert.equal(inspectAccessibility([{id: command.id, display: localized}]).conflicts.length, 0);
  assert.equal(inspectThemeContrast(exampleTheme).failures, 0);
  server = await createWorkspaceServer({root, workspaceId, token, notice: {id: 'configuration-example', version: '1', text: 'Disposable local SDK configuration example.'}, plugins: [{plugin, artifactSha256}], settings: {[plugin.manifest.id]: store}, secrets: resolver, grants: ['settings.read', 'secrets.resolve'], jobs: true});
  client = createWorkspaceClient({url: server.url, token}); const hello = await client.connect();
  assert.equal(hello.plugins[0].commands[0].inputSchema.schemaVersion, 1);
  const input = parseCommandInput({options: {names: ['Ada', '한글']} , token: store.read(workspaceId).values.token}, command);
  assert.equal(input.options.mode, 'short');
  assert.throws(() => parseCommandInput({...input, options: {names: ['']}}, command), error => error.path === '/input/options/names/0');
  await assert.rejects(client.runCommand(plugin.manifest.id, 'summarize', {...input, options: {names: []}}, artifactSha256)); assert.equal(executions, 0);
  const output = parseCommandOutput(await client.runCommand(plugin.manifest.id, 'summarize', input, artifactSha256), command);
  assert.deepEqual(output, {count: 2, total: 8, mode: 'short', authorized: true});
  let job = await client.startCommandJob(plugin.manifest.id, 'summarize', input, artifactSha256, {jobId: randomUUID()});
  for (let poll = 0; job.state === 'running' && poll < 100; poll++) {await new Promise(resolve => setTimeout(resolve, 10)); job = await client.getJob(job.jobId);}
  assert.equal(job.state, 'succeeded'); assert.equal(job.result.total, 8);
  allowed = false; await assert.rejects(client.runCommand(plugin.manifest.id, 'summarize', input, artifactSha256), error => error.code === 'permission_denied');
  allowed = true; resolver.revoke(reference); await assert.rejects(client.runCommand(plugin.manifest.id, 'summarize', input, artifactSha256), error => error.code === 'permission_denied');
  store.update({workspaceId, scope: 'workspace', expectedRevision: 2, reset: ['multiplier', 'token']}); assert.equal(store.read(workspaceId).values.multiplier, 3);
  await assert.rejects(store.migrate({...settingsDefinition, version: 2}, () => {throw new Error('migration fixture');}, {expectedRevision: 3}), error => error.code === 'provider_failed'); assert.equal(store.read(workspaceId).definitionVersion, 1);
  await store.migrate({...settingsDefinition, version: 2}, before => ({user: before.user, workspaces: before.workspaces}), {expectedRevision: 3}); assert.equal(store.read(workspaceId).definitionVersion, 2);
  subscription.dispose(); assert.equal(store.inspect().subscriptions, 0);
  assert.equal(JSON.stringify(store.exportState()).includes(privateMaterial.toString('hex')), false);
  console.log('Configuration: scoped CAS settings, migration rollback, structured HTTP commands/jobs, isolated secret references and revocation verified');
} finally {
  client?.dispose(); await server?.close(); store.dispose(); resolver.dispose(); privateMaterial.fill(0);
  assert.equal(path.dirname(root), await realpath(tmpdir())); assert.ok(path.basename(root).startsWith('dds-configuration-example-')); await rm(root, {recursive: true});
}
