import {configurationCopy as copy, configurationObject as object, configurationFailure as fail, configurationText as text, configurationKey as key, freezeConfiguration as freeze, parseDisplayMetadata} from './configuration-values.mjs';
import {parseManifest, parseCommandDefinition} from './contracts.mjs';
import {parseSettingsDefinition} from './settings.mjs';
import {describeDataForm} from './data-schema.mjs';
import {parseTheme} from './themes.mjs';

export const LOCALIZATION_LIMITS = Object.freeze({catalogBytes: 262_144, locales: 32, keys: 256, messageCharacters: 4096, formattedCharacters: 16_384, placeholders: 32, surfaces: 2048});
const catalogs = new WeakSet(), owns = (object, name) => Object.hasOwn(object, name);
const placeholderPattern = /\{([A-Za-z][A-Za-z0-9_.-]{0,127})\}/g;

/** Canonical BCP 47 base tags; extension/private-use negotiation is not supported. */
export function canonicalLocale(input) {
  text(input, 64);
  try {
    const [locale] = Intl.getCanonicalLocales(input);
    if (!locale || new Intl.Locale(locale).baseName !== locale) throw new Error();
    return locale;
  } catch {fail('locale');}
}
export function messagePlaceholders(input) {
  text(input, LOCALIZATION_LIMITS.messageCharacters, '', 0);
  const names = [...new Set([...input.matchAll(placeholderPattern)].map(match => match[1]))].sort();
  if (/[{}]/.test(input.replace(placeholderPattern, '')) || names.some(name => {try {key(name); return false;} catch {return true;}})) fail('placeholder_syntax');
  if (names.length > LOCALIZATION_LIMITS.placeholders) fail('budget', '', true);
  return Object.freeze(names);
}

export function parseLocaleCatalog(input) {
  if (catalogs.has(input)) return input;
  const value = copy(input, LOCALIZATION_LIMITS.catalogBytes);
  object(value, ['schemaVersion', 'defaultLocale', 'messages'], ['fallbacks']);
  if (value.schemaVersion !== 1) fail('schema_version');
  if (canonicalLocale(value.defaultLocale) !== value.defaultLocale) fail('canonical_locale');
  if (!value.messages || typeof value.messages !== 'object' || Array.isArray(value.messages)) fail('messages');
  const locales = Object.keys(value.messages);
  if (!locales.length || locales.length > LOCALIZATION_LIMITS.locales) fail('budget', '', true);
  if (!locales.includes(value.defaultLocale)) fail('default_locale');
  const primary = value.messages[value.defaultLocale];
  if (!primary || typeof primary !== 'object' || Array.isArray(primary)) fail('messages');
  const keys = Object.keys(primary);
  if (!keys.length || keys.length > LOCALIZATION_LIMITS.keys) fail('budget', '', true);
  keys.forEach(name => key(name));
  const requiredPlaceholders = new Map(keys.map(name => [name, messagePlaceholders(primary[name]).join('\0')]));
  for (const locale of locales) {
    if (canonicalLocale(locale) !== locale) fail('canonical_locale');
    const messages = value.messages[locale];
    if (!messages || typeof messages !== 'object' || Array.isArray(messages)) fail('messages');
    for (const [name, message] of Object.entries(messages)) {
      if (!owns(primary, name)) fail('unknown_message_key');
      if (messagePlaceholders(message).join('\0') !== requiredPlaceholders.get(name)) fail('placeholder_mismatch');
    }
  }
  const fallbacks = value.fallbacks ?? {};
  if (!fallbacks || typeof fallbacks !== 'object' || Array.isArray(fallbacks)) fail('fallbacks');
  for (const [locale, targets] of Object.entries(fallbacks)) {
    if (!locales.includes(locale) || !Array.isArray(targets) || targets.length > LOCALIZATION_LIMITS.locales || new Set(targets).size !== targets.length || targets.some(target => !locales.includes(target))) fail('fallbacks');
    if (locale === value.defaultLocale && targets.length) fail('default_fallback');
  }
  const visited = new Set();
  const visit = (locale, active = new Set()) => {
    if (active.has(locale)) fail('fallback_cycle');
    if (visited.has(locale)) return;
    const next = new Set(active); next.add(locale);
    for (const target of fallbacks[locale] ?? []) visit(target, next);
    visited.add(locale);
  };
  locales.forEach(locale => visit(locale));
  catalogs.add(value); return value;
}

export function negotiateLocale(catalog, requested) {
  catalog = parseLocaleCatalog(catalog);
  const values = copy(typeof requested === 'string' ? [requested] : requested, 2048);
  if (!Array.isArray(values) || !values.length || values.length > 8) fail('locale_preferences');
  // Validate every requested entry even if the first one is supported.
  const locales = values.map(canonicalLocale);
  for (let locale of locales) {
    while (locale) {if (owns(catalog.messages, locale)) return locale; const separator = locale.lastIndexOf('-'); if (separator < 0) break; locale = locale.slice(0, separator);}
  }
  return catalog.defaultLocale;
}
function chain(catalog, locale) {
  const order = [], visited = new Set();
  function visit(current) {if (visited.has(current)) return; visited.add(current); order.push(current); for (const target of catalog.fallbacks?.[current] ?? []) visit(target);}
  visit(locale); visit(catalog.defaultLocale); return order;
}
/** A layout hint based on the tag's maximized script, not a font/shaping check. */
export function localeDirection(locale) {
  const script = new Intl.Locale(canonicalLocale(locale)).maximize().script;
  return ['Arab', 'Hebr', 'Thaa', 'Nkoo', 'Adlm', 'Rohg', 'Syrc', 'Mand', 'Samr'].includes(script) ? 'rtl' : 'ltr';
}
export function resolveMessage(catalog, requested, name, argumentsInput = {}) {
  catalog = parseLocaleCatalog(catalog); key(name);
  const requestedLocale = canonicalLocale(requested), selected = negotiateLocale(catalog, requestedLocale);
  if (!owns(catalog.messages[catalog.defaultLocale], name)) fail('missing_message_key');
  const locale = chain(catalog, selected).find(locale => owns(catalog.messages[locale], name));
  const message = catalog.messages[locale][name], names = messagePlaceholders(message), args = copy(argumentsInput, 65_536);
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== names.length || names.some(name => !owns(args, name))) fail('message_arguments');
  for (const value of Object.values(args)) {
    if (typeof value === 'string') text(value, LOCALIZATION_LIMITS.messageCharacters, '', 0);
    else if (!(typeof value === 'number' && Number.isFinite(value)) && typeof value !== 'boolean') fail('message_argument_type');
  }
  // One replacement pass. Values are literal text, never recursively interpolated.
  const result = message.replace(placeholderPattern, (_match, name) => String(args[name]));
  text(result, LOCALIZATION_LIMITS.formattedCharacters, '', 0);
  return Object.freeze({key: name, text: result, locale, requestedLocale, fallback: locale !== requestedLocale, direction: localeDirection(locale)});
}
export function formatMessage(catalog, locale, name, args) {return resolveMessage(catalog, locale, name, args).text;}

function supportedIntl(constructor, locale) {
  locale = canonicalLocale(locale);
  if (!constructor.supportedLocalesOf([locale]).length) fail('intl_unavailable');
  return locale;
}
export function formatLocaleNumber(locale, value, options = {}) {
  locale = supportedIntl(Intl.NumberFormat, locale); options = copy(options, 2048); object(options, [], ['style', 'minimumFractionDigits', 'maximumFractionDigits', 'useGrouping']);
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('number');
  if (options.style !== undefined && !['decimal', 'percent'].includes(options.style) || options.useGrouping !== undefined && typeof options.useGrouping !== 'boolean') fail('number_options');
  for (const name of ['minimumFractionDigits', 'maximumFractionDigits']) if (owns(options, name) && (!Number.isInteger(options[name]) || options[name] < 0 || options[name] > 10)) fail('number_options');
  try {return new Intl.NumberFormat(locale, options).format(value);} catch {fail('number_options');}
}
export function formatLocaleDate(locale, epochMs, options = {}) {
  locale = supportedIntl(Intl.DateTimeFormat, locale); options = copy(options, 2048); object(options, [], ['dateStyle', 'timeStyle', 'timeZone']);
  if (!Number.isSafeInteger(epochMs) || Math.abs(epochMs) > 8_640_000_000_000_000) fail('date');
  for (const name of ['dateStyle', 'timeStyle']) if (owns(options, name) && !['full', 'long', 'medium', 'short'].includes(options[name])) fail('date_options');
  if (options.timeZone !== undefined) text(options.timeZone, 128);
  try {return new Intl.DateTimeFormat(locale, {dateStyle: 'medium', timeZone: 'UTC', ...options}).format(epochMs);} catch {fail('date_options');}
}
export function selectLocalePlural(locale, value, options = {}) {
  locale = supportedIntl(Intl.PluralRules, locale); options = copy(options, 1024); object(options, [], ['type']);
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('number');
  if (options.type !== undefined && !['cardinal', 'ordinal'].includes(options.type)) fail('plural_options');
  return new Intl.PluralRules(locale, options).select(value);
}

export function localizeDisplay(catalog, locale, display) {
  catalog = parseLocaleCatalog(catalog); locale = canonicalLocale(locale); display = parseDisplayMetadata(display);
  const result = {...display};
  for (const name of ['label', 'help']) if (display[name + 'Key']) result[name] = formatMessage(catalog, locale, display[name + 'Key']);
  if (display.accessibility) {
    result.accessibility = {...display.accessibility};
    for (const name of ['name', 'description']) if (display.accessibility[name + 'Key']) result.accessibility[name] = formatMessage(catalog, locale, display.accessibility[name + 'Key']);
  }
  return parseDisplayMetadata(result);
}

/** Cross-check explicit module exports; no catalog file loading or automatic translation. */
export function validateLocalizedSurfaces(catalog, surfaces) {
  catalog = parseLocaleCatalog(catalog); surfaces = copy(surfaces, 1_048_576); object(surfaces, [], ['manifest', 'commands', 'settings', 'themes']);
  const entries = [], names = new Set();
  const add = (id, display) => {if (display) {if (entries.length >= LOCALIZATION_LIMITS.surfaces) fail('budget', '', true); entries.push({id, display: parseDisplayMetadata(display)});}};
  if (surfaces.manifest) {const manifest = parseManifest(surfaces.manifest); add('manifest', manifest.display);}
  if (surfaces.commands) {
    if (!Array.isArray(surfaces.commands) || surfaces.commands.length > 64) fail('commands');
    surfaces.commands.forEach(input => {
      const command = parseCommandDefinition(input); if (names.has(command.id)) fail('duplicate_command'); names.add(command.id); add('command/' + command.id, command.display);
      for (const field of ['inputSchema', 'outputSchema']) if (command[field]) for (const item of describeDataForm(command[field])) add('command/' + command.id + '/' + field + item.path, item.display);
    });
  }
  if (surfaces.settings) {
    const definition = parseSettingsDefinition(surfaces.settings);
    for (const [name, setting] of Object.entries(definition.settings)) {add('settings/' + name, setting.display); for (const item of describeDataForm(setting.schema)) add('settings/' + name + item.path, item.display);}
  }
  if (surfaces.themes) {
    if (!Array.isArray(surfaces.themes) || surfaces.themes.length > 16) fail('themes');
    surfaces.themes.forEach((entry, index) => {object(entry, ['theme', 'display']); parseTheme(entry.theme); add('theme/' + index, entry.display);});
  }
  const used = new Set();
  for (const {display} of entries) {
    const keys = [display.labelKey, display.helpKey, display.accessibility?.nameKey, display.accessibility?.descriptionKey].filter(Boolean);
    for (const name of keys) {if (!owns(catalog.messages[catalog.defaultLocale], name)) fail('missing_display_key'); if (messagePlaceholders(catalog.messages[catalog.defaultLocale][name]).length) fail('display_placeholder'); used.add(name);}
    // Every offered locale must produce bounded display data, including fallback.
    for (const locale of Object.keys(catalog.messages)) localizeDisplay(catalog, locale, display);
  }
  const missingTranslations = [];
  for (const locale of Object.keys(catalog.messages)) for (const name of used) if (!owns(catalog.messages[locale], name)) missingTranslations.push({locale, key: name});
  return freeze({keys: [...used].sort(), missingTranslations, surfaces: entries.length});
}
