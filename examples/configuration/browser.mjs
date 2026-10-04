import {createPluginHost, parseCommandInput} from '@altifigence/dds-plugin-sdk';
import {createSettingsStore} from '@altifigence/dds-plugin-sdk/settings';
import {createSecretResolver} from '@altifigence/dds-plugin-sdk/secrets';
import {describeDataForm} from '@altifigence/dds-plugin-sdk/data-schema';
import {localizeDisplay, localeDirection, validateLocalizedSurfaces, formatLocaleNumber, resolveMessage} from '@altifigence/dds-plugin-sdk/localization';
import {inspectAccessibility, inspectThemeContrast} from '@altifigence/dds-plugin-sdk/accessibility';
import {settingsDefinition, command, createConfigurationPlugin} from './plugin.mjs';
import {catalog, exampleTheme} from './catalog.mjs';

const element = id => document.getElementById(id), workspaceId = crypto.randomUUID(), store = createSettingsStore(settingsDefinition);
let locale = 'en', reference, revoked = false, view, result, failure, waiting = false, release, submitted, executions = 0;
const privateMaterial = crypto.getRandomValues(new Uint8Array(16));
const resolver = createSecretResolver({authorize: () => !revoked, resolve: () => privateMaterial});
function renew() {
  if (reference) resolver.revoke(reference);
  revoked = false; reference = resolver.issue({secretId: 'browser-fixture', pluginId: settingsDefinition.pluginId, workspaceId, commandIds: ['summarize'], ttlMs: 3_600_000});
  store.update({workspaceId, scope: 'workspace', expectedRevision: store.read(workspaceId).revision, values: {token: reference}});
}
renew(); view = store.read(workspaceId);
const plugin = createConfigurationPlugin({onStart: async ({signal}) => {
  executions++;
  if (element('hold').checked) {
    waiting = true; render();
    await new Promise(resolve => {const finish = () => {signal.removeEventListener('abort', finish); resolve();}; release = finish; signal.addEventListener('abort', finish, {once: true}); if (signal.aborted) finish();});
    release = undefined; waiting = false;
  }
}});
const host = createPluginHost({hostId: 'workspace-host', scope: {projectId: workspaceId, sessionId: crypto.randomUUID()}, settings: {[plugin.manifest.id]: store}, secrets: resolver, grants: ['settings.read', 'secrets.resolve']});
await host.activate(plugin);
const report = validateLocalizedSurfaces(catalog, {manifest: plugin.manifest, commands: [command], settings: settingsDefinition, themes: [{theme: exampleTheme, display: {labelKey: 'theme.name'}}]});
const contrast = inspectThemeContrast(exampleTheme), namesField = describeDataForm(command.inputSchema).find(field => field.path === '/options/names');
function show(target, key, args) {
  const translation = resolveMessage(catalog, locale, key, args);
  target.textContent = translation.text; target.lang = translation.locale; target.dir = translation.direction;
}
function render() {
  document.documentElement.lang = locale; document.documentElement.dir = localeDirection(locale);
  for (const target of document.querySelectorAll('[data-text]')) show(target, target.dataset.text);
  const commandDisplay = localizeDisplay(catalog, locale, command.display), settingDisplay = localizeDisplay(catalog, locale, settingsDefinition.settings.multiplier.display);
  show(element('run'), command.display.labelKey); element('run').setAttribute('aria-label', commandDisplay.accessibility.name); element('run').setAttribute('aria-keyshortcuts', commandDisplay.accessibility.shortcut);
  show(element('multiplier-label'), settingsDefinition.settings.multiplier.display.labelKey); element('multiplier').setAttribute('aria-label', settingDisplay.accessibility.name);
  show(element('names-label'), namesField.display.labelKey); show(element('names-help'), namesField.display.helpKey);
  show(element('effective'), 'settings.effective', {value: view.values.multiplier, source: view.sources.multiplier, revision: view.revision});
  element('format').textContent = view.values.format;
  show(element('reference-state'), revoked ? 'reference.revoked' : 'reference.active');
  element('continue').hidden = !waiting;
  show(element('result'), waiting ? 'execution.waiting' : result ? 'result.summary' : 'execution.ready', result && !waiting ? {count: formatLocaleNumber(locale, result.count), total: formatLocaleNumber(locale, result.total), mode: result.mode} : undefined);
  if (failure) show(element('error'), failure.path ? 'error.validation' : 'error.operation', failure.path ? {path: failure.path} : {code: failure.code ?? 'invalid_contract'}); else element('error').textContent = '';
  element('receipt').textContent = JSON.stringify({commandId: command.id, settingsKey: 'multiplier', executions, ...(submitted ? {submitted: {options: submitted.options, reference: 'opaque'}} : {}), ...(result ? {result} : {})}, null, 2);
  const accessibility = inspectAccessibility([{id: command.id, display: commandDisplay}, {id: 'multiplier', display: settingDisplay}]);
  show(element('audit'), 'audit.summary', {conflicts: accessibility.conflicts.length, contrast: contrast.failures, missing: catalog.messages[locale] ? report.missingTranslations.filter(item => item.locale === locale).length : report.keys.length});
  const source = resolveMessage(catalog, locale, 'command.help'); element('fallback').textContent = source.fallback ? 'English source · ' + source.locale : 'Translation: ' + source.locale; element('fallback').dir = 'ltr'; element('fallback').lang = 'en';
}
function act(operation) {try {operation(); failure = undefined;} catch (error) {failure = error;} view = store.read(workspaceId); render();}
element('locale').addEventListener('change', () => {locale = element('locale').value; render();});
element('theme').addEventListener('click', () => {document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';});
element('save').addEventListener('click', () => act(() => store.update({workspaceId, scope: element('scope').value, expectedRevision: view.revision, values: {multiplier: Number(element('multiplier').value)}})));
element('reset').addEventListener('click', () => act(() => {store.update({workspaceId, scope: element('scope').value, expectedRevision: view.revision, reset: ['multiplier']}); element('multiplier').value = String(store.read(workspaceId).values.multiplier);}));
element('revoke').addEventListener('click', () => act(() => {resolver.revoke(reference); revoked = true;}));
element('renew').addEventListener('click', () => act(renew));
element('continue').addEventListener('click', () => {release?.(); release = undefined;});
element('run').addEventListener('click', async () => {
  if (element('run').disabled) return;
  result = undefined; failure = undefined; submitted = undefined;
  try {
    submitted = parseCommandInput({options: {names: element('names').value.split(',').map(name => name.trim()), mode: element('mode').value}, token: reference}, command);
    element('run').disabled = true; render(); result = await host.executeCommand(plugin.manifest.id, command.id, submitted, {timeoutMs: 30_000});
  } catch (error) {failure = error;}
  finally {element('run').disabled = false; waiting = false; render();}
});
document.addEventListener('keydown', event => {if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'Enter') {event.preventDefault(); element('run').click();}});
const subscription = store.subscribe(workspaceId, next => {view = next; render();});
window.addEventListener('pagehide', () => {release?.(); subscription.dispose(); host.dispose(); store.dispose(); resolver.dispose(); privateMaterial.fill(0);}, {once: true});
render();
