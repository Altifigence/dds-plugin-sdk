import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLocaleCatalog, canonicalLocale, negotiateLocale, resolveMessage, formatMessage, messagePlaceholders, localeDirection, localizeDisplay, validateLocalizedSurfaces, formatLocaleNumber, formatLocaleDate, selectLocalePlural, LOCALIZATION_LIMITS} from '../src/localization.mjs';
import {inspectAccessibility, normalizeShortcut, contrastRatio, inspectThemeContrast} from '../src/accessibility.mjs';
import {parseCommandDefinition, parseCommandInput, createPluginHost, definePlugin} from '../src/index.mjs';
import {SCHEMAS} from '../src/schemas.mjs';
import {deferred, hasCode} from './fixtures.mjs';

const base = () => ({schemaVersion: 1, defaultLocale: 'en', messages: {en: {greet: 'Hello {name}', title: 'Run', help: 'Start the command', count: '{count} results'}, ko: {greet: '안녕하세요 {name}', title: '실행'}, ar: {greet: 'مرحبًا {name}', title: 'تشغيل'}, fr: {title: 'Exécuter'}}, fallbacks: {ko: ['fr'], ar: ['en']}});

test('canonical locales, preference negotiation and deterministic per-key fallback preserve source locale', () => {
  const catalog = parseLocaleCatalog(base());
  assert.equal(canonicalLocale('ko-kr'), 'ko-KR'); assert.equal(negotiateLocale(catalog, ['de-DE', 'ko-KR']), 'ko');
  assert.equal(negotiateLocale(catalog, 'zh-Hans-CN'), 'en'); assert.equal(resolveMessage(catalog, 'ko-KR', 'title').locale, 'ko');
  assert.equal(resolveMessage(catalog, 'ko', 'help').locale, 'en'); assert.equal(resolveMessage(catalog, 'ko', 'help').fallback, true);
  assert.equal(formatMessage(catalog, 'ar', 'greet', {name: 'Ada'}), 'مرحبًا Ada');
  assert.equal(localeDirection('ar-EG'), 'rtl'); assert.equal(localeDirection('az-Arab'), 'rtl'); assert.equal(localeDirection('ko-KR'), 'ltr');
  for (const locale of ['not_a_locale', 'en-u-ca-gregory', '', 'x-private']) assert.throws(() => canonicalLocale(locale), hasCode('invalid_contract'));
  assert.throws(() => negotiateLocale(catalog, ['en', 'bad_']), hasCode('invalid_contract'));
});

test('catalogs reject cycles, unresolved fallbacks, unknown keys and placeholder mismatches', () => {
  for (const change of [
    value => {value.fallbacks = {ko: ['fr'], fr: ['ko']};},
    value => {value.fallbacks = {ko: ['de']};},
    value => {value.fallbacks = {en: ['ko']};},
    value => {value.messages.ko.greet = 'Hi {different}';},
    value => {value.messages.ko.extra = 'unregistered';},
    value => {value.messages.en.greet = 'Hello {{name}}';},
    value => {value.messages['en-us'] = {};},
    value => {value.defaultLocale = 'de';},
  ]) {const input = base(); change(input); assert.throws(() => parseLocaleCatalog(input), hasCode('invalid_contract'));}
  assert.throws(() => formatMessage(base(), 'en', 'absent'), hasCode('invalid_contract'));
});

test('messages and arguments remain literal and bounded without executing hooks', () => {
  const catalog = parseLocaleCatalog(base()); const malicious = '<img src=x onerror=alert(1)> {name}';
  assert.equal(formatMessage(catalog, 'en', 'greet', {name: malicious}), 'Hello ' + malicious);
  assert.deepEqual(messagePlaceholders('{a} {a} {b}'), ['a', 'b']);
  for (const args of [{}, {name: 'A', extra: 'B'}, {name: null}, {name: NaN}]) assert.throws(() => formatMessage(catalog, 'en', 'greet', args), hasCode('invalid_contract'));
  let hooks = 0;
  assert.throws(() => parseLocaleCatalog({...base(), get messages() {hooks++; return {};}}));
  assert.throws(() => formatMessage(catalog, 'en', 'greet', {get name() {hooks++; return '';}})); assert.equal(hooks, 0);
  const long = base(); long.messages.en.title = 'x'.repeat(LOCALIZATION_LIMITS.messageCharacters + 1); assert.throws(() => parseLocaleCatalog(long));
  const expanding = {schemaVersion: 1, defaultLocale: 'en', messages: {en: {many: Array(20).fill('{name}').join('')}}};
  assert.throws(() => formatMessage(expanding, 'en', 'many', {name: 'x'.repeat(4096)}));
  const detached = base(), parsed = parseLocaleCatalog(detached); detached.messages.en.title = 'mutated'; assert.equal(formatMessage(parsed, 'en', 'title'), 'Run');
});

test('explicit Intl helpers use bounded options, UTC dates and supported locales', () => {
  assert.equal(formatLocaleNumber('en-US', 1234.5), '1,234.5'); assert.equal(formatLocaleNumber('de-DE', 1234.5), '1.234,5');
  assert.equal(formatLocaleDate('en-US', Date.UTC(2026, 9, 4), {dateStyle: 'short'}), '10/4/26');
  assert.equal(selectLocalePlural('en', 1), 'one'); assert.equal(selectLocalePlural('en', 2), 'other'); assert.equal(selectLocalePlural('ar', 2), 'two');
  for (const run of [() => formatLocaleNumber('en', NaN), () => formatLocaleNumber('en', 1, {maximumFractionDigits: 11}), () => formatLocaleNumber('en', 1, {currency: 'USD'}), () => formatLocaleDate('en', 0, {timeZone: 'Not/AZone'}), () => formatLocaleDate('en', Infinity), () => selectLocalePlural('en', 1, {type: 'expression'})]) assert.throws(run);
});

test('manifest, commands, settings and theme display cross-checks leave IDs and values unchanged', () => {
  const catalog = base(), display = {labelKey: 'title', helpKey: 'help', accessibility: {nameKey: 'title', descriptionKey: 'help', shortcut: 'Control+Enter'}};
  const command = parseCommandDefinition({id: 'stable-command', title: 'Fallback', display, inputSchema: {schemaVersion: 1, schema: {type: 'string', display, default: 'stable-value'}}});
  const settings = {schemaVersion: 1, pluginId: 'stable', version: 1, settings: {stableKey: {scopes: ['workspace'], display, schema: {schemaVersion: 1, schema: {type: 'boolean', default: true}}}}};
  const report = validateLocalizedSurfaces(catalog, {commands: [command], settings, themes: [{theme, display}]});
  assert.ok(report.missingTranslations.some(item => item.locale === 'ko' && item.key === 'help'));
  assert.equal(localizeDisplay(catalog, 'ko', display).accessibility.name, '실행'); assert.equal(command.id, 'stable-command'); assert.equal(parseCommandInput(undefined, command), 'stable-value');
  assert.throws(() => validateLocalizedSurfaces(catalog, {commands: [{id: 'bad', title: 'Bad', display: {labelKey: 'missing'}}]}), error => error.reason === 'missing_display_key');
  assert.throws(() => validateLocalizedSurfaces(catalog, {commands: [{id: 'bad', title: 'Bad', display: {labelKey: 'greet'}}]}), error => error.reason === 'display_placeholder');
  const oversized = base(); oversized.messages.ko.title = '한'.repeat(257); assert.throws(() => validateLocalizedSurfaces(oversized, {commands: [command]}));
});

const theme = {name: 'Contrast fixture', colors: {light: {backdrop: '#ffffff', navigation: '#ffffff', tool: '#ffffff', main: '#ffffff', text: '#000000', muted: '#777777'}, dark: {backdrop: '#000000', navigation: '#000000', tool: '#000000', main: '#000000', text: '#ffffff', muted: '#777777'}}};
test('accessibility reports exact keyboard conflicts and unrounded opaque-color contrast', () => {
  assert.equal(normalizeShortcut('shift+control+k'), 'Control+Shift+K');
  for (const value of ['Ctrl+K', 'Control+Control+K', 'Control', '<script>', 'Alt++']) assert.throws(() => normalizeShortcut(value));
  const report = inspectAccessibility([{id: 'one', display: {label: 'One', accessibility: {shortcut: 'Shift+Control+K'}}}, {id: 'two', display: {label: 'Two', accessibility: {shortcut: 'Control+Shift+K'}}}, {id: 'missing', display: {help: 'No label'}}]);
  assert.deepEqual(report.conflicts, [{shortcut: 'Control+Shift+K', ids: ['one', 'two']}]); assert.deepEqual(report.issues, [{id: 'missing', code: 'missing_name'}]);
  assert.equal(contrastRatio('#000000', '#ffffff'), 21); assert.equal(contrastRatio('#abcdef', '#abcdef'), 1);
  const checks = inspectThemeContrast(theme).checks; assert.equal(checks.length, 10);
  const lightMuted = checks.find(item => item.mode === 'light' && item.foreground === 'muted'); assert.ok(lightMuted.ratio > 4.47 && lightMuted.ratio < 4.5); assert.equal(lightMuted.passes, false);
  assert.throws(() => contrastRatio('#fff', '#ffffff')); assert.throws(() => inspectThemeContrast(theme, {minimum: 22}));
});

test('locale changes during an execution only change displayed metadata', async () => {
  const gate = deferred(), started = deferred(); let locale = 'en';
  const metadata = {id: 'run', title: 'Run', display: {labelKey: 'title'}, inputSchema: {schemaVersion: 1, schema: {type: 'string'}}};
  const manifest = {manifestVersion: 2, id: 'locale-example', name: 'Locale', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', capabilities: ['commands'], permissions: [], supportedHosts: ['test-host'], license: 'MIT', source: {visibility: 'open', licenseFile: 'LICENSE'}, display: {labelKey: 'title'}};
  const host = createPluginHost(); await host.activate(definePlugin(manifest, context => context.registerCommand(metadata, async input => {started.resolve(); await gate.promise; return input;})));
  validateLocalizedSurfaces(base(), {manifest, commands: [metadata]}); const result = host.executeCommand(manifest.id, 'run', 'unchanged input'); await started.promise;
  locale = 'ko'; assert.equal(localizeDisplay(base(), locale, metadata.display).label, '실행'); gate.resolve(); assert.equal(await result, 'unchanged input'); assert.equal(host.listCommands()[0].id, 'run'); host.dispose();
});

test('generated configuration schemas resolve every local reference and match runtime discriminators', () => {
  for (const name of ['data-schema', 'settings-definition', 'command', 'locale-catalog', 'localized-message']) {
    const root = SCHEMAS[name]; assert.ok(root);
    const visit = value => {if (!value || typeof value !== 'object') return; if (value.$ref?.startsWith('#/')) {let target = root; for (const part of value.$ref.slice(2).split('/')) target = target?.[part]; assert.ok(target, name + ' has an unresolved reference');} Object.values(value).forEach(visit);}; visit(root);
  }
  assert.equal(SCHEMAS.command.properties.inputSchema.properties.schemaVersion.const, 1); assert.equal(SCHEMAS.manifest.oneOf[1].properties.display.additionalProperties, false);
});
