// SPDX-FileCopyrightText: 2026 Altifigence
// SPDX-License-Identifier: Apache-2.0
import { ErrorCode, PluginSdkError } from './limits.mjs';

export const THEME_XML_MAX_BYTES = 65_536;
export const THEME_COLOR_KEYS = Object.freeze(['backdrop', 'navigation', 'tool', 'main', 'text', 'muted']);
export const THEME_TOKEN_COLOR_KEYS = Object.freeze([
  'search', 'searchText', 'searchPlaceholder', 'searchBorder', 'selection', 'selectionText',
  'tabActive', 'tabInactive', 'tabText', 'rail', 'panelBorder', 'popover', 'focus',
  'success', 'warning', 'danger', 'info', 'aiBall',
  'hintsBoxBackground', 'hintsBoxDetailsBackground', 'hintsBoxText', 'hintsBoxDetailsText', 'hintsBoxMutedText',
  'hintsBoxSelectedBackground', 'hintsBoxSelectedText', 'hintsBoxHoverBackground', 'hintsBoxHoverText',
  'gdsBackground',
]);
export const THEME_METRICS = Object.freeze({
  panelRadius: Object.freeze({ min: 0, max: 24, default: 14, integer: true }),
  controlRadius: Object.freeze({ min: 0, max: 16, default: 6, integer: true }),
  popoverRadius: Object.freeze({ min: 0, max: 24, default: 12, integer: true }),
  popoverOpacity: Object.freeze({ min: 0.6, max: 1, default: 0.72, integer: false }),
});
const modes = ['light', 'dark'];
const encoder = new TextEncoder();
const hexColor = /^#[0-9a-fA-F]{6}$/;

function invalid(path, explanation) {
  throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, `${path}: ${explanation}`);
}

function byteLimit(text, location) {
  if (text.length > THEME_XML_MAX_BYTES || encoder.encode(text).byteLength > THEME_XML_MAX_BYTES) {
    throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, `${location}: exceeds 64 KiB UTF-8`);
  }
}

// Read descriptors, not caller getters or toJSON hooks, before creating a safe copy.
function dataFields(value, allowed, required, location) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(location, 'expected a plain object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(location, 'expected a plain object');
  const keys = Reflect.ownKeys(value);
  if (keys.length > allowed.length) invalid(location, 'unexpected fields');
  const result = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid(location, 'unexpected field');
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) invalid(location, 'expected enumerable data fields');
    result[key] = field.value;
  }
  for (const key of required) if (!Object.hasOwn(result, key)) invalid(`${location}.${key}`, 'required');
  return result;
}

function themeName(raw) {
  if (typeof raw !== 'string') invalid('theme.name', 'expected text');
  byteLimit(raw, 'theme.name');
  const name = raw.trim();
  if (!name.length || name.length > 80) invalid('theme.name', 'expected 1..80 UTF-16 code units after trimming');
  for (const character of raw) {
    const point = character.codePointAt(0);
    if (point !== 9 && point !== 10 && point !== 13 && !(point >= 0x20 && point <= 0xd7ff)
      && !(point >= 0xe000 && point <= 0xfffd) && !(point >= 0x10000 && point <= 0x10ffff)) {
      invalid('theme.name', 'expected XML 1.0 characters');
    }
  }
  return name;
}

function colorFields(value, keys, complete, location) {
  const fields = dataFields(value, keys, complete ? keys : [], location);
  const colors = {};
  for (const key of keys) if (Object.hasOwn(fields, key)) {
    if (typeof fields[key] !== 'string' || fields[key].length !== 7 || !hexColor.test(fields[key])) invalid(`${location}.${key}`, 'expected #RRGGBB');
    colors[key] = fields[key].toLowerCase();
  }
  return Object.freeze(colors);
}

/** Validate JSON data and return a canonical immutable DDS theme. Performs no I/O. */
export function parseTheme(input) {
  if (typeof input === 'string') {
    byteLimit(input, 'theme JSON');
    try { input = JSON.parse(input); } catch { invalid('theme', 'expected valid JSON'); }
  }
  const root = dataFields(input, ['name', 'colors'], ['name', 'colors'], 'theme');
  const name = themeName(root.name);
  const supplied = dataFields(root.colors, ['light', 'dark', 'tokens', 'metrics'], modes, 'theme.colors');
  const colors = {
    light: colorFields(supplied.light, THEME_COLOR_KEYS, true, 'theme.colors.light'),
    dark: colorFields(supplied.dark, THEME_COLOR_KEYS, true, 'theme.colors.dark'),
  };
  if (Object.hasOwn(supplied, 'tokens')) {
    const tokenModes = dataFields(supplied.tokens, modes, [], 'theme.colors.tokens');
    const tokens = {};
    for (const mode of modes) if (Object.hasOwn(tokenModes, mode)) {
      tokens[mode] = colorFields(tokenModes[mode], THEME_TOKEN_COLOR_KEYS, false, `theme.colors.tokens.${mode}`);
    }
    colors.tokens = Object.freeze(tokens);
  }
  if (Object.hasOwn(supplied, 'metrics')) {
    const metrics = dataFields(supplied.metrics, Object.keys(THEME_METRICS), [], 'theme.colors.metrics');
    const checked = {};
    for (const [key, bounds] of Object.entries(THEME_METRICS)) if (Object.hasOwn(metrics, key)) {
      const value = metrics[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < bounds.min || value > bounds.max
        || bounds.integer && !Number.isInteger(value)) invalid(`theme.colors.metrics.${key}`, 'outside supported numeric range');
      checked[key] = Object.is(value, -0) ? 0 : value;
    }
    colors.metrics = Object.freeze(checked);
  }
  const theme = Object.freeze({ name, colors: Object.freeze(colors) });
  byteLimit(JSON.stringify(theme), 'theme JSON');
  return theme;
}

function attribute(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
    .replaceAll('\t', '&#9;').replaceAll('\n', '&#10;').replaceAll('\r', '&#13;');
}

/** Produce a bounded DDS XML v2 file from validated JSON data. Performs no I/O. */
export function serializeThemeXml(input) {
  const theme = parseTheme(input);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<dds-theme version="2" name="${attribute(theme.name)}">`];
  for (const mode of modes) {
    lines.push(`  <palette mode="${mode}">`);
    for (const key of THEME_COLOR_KEYS) lines.push(`    <color key="${key}" value="${theme.colors[mode][key]}"/>`);
    lines.push('  </palette>');
  }
  for (const mode of modes) if (theme.colors.tokens?.[mode]) {
    lines.push(`  <tokens mode="${mode}">`);
    for (const key of THEME_TOKEN_COLOR_KEYS) if (Object.hasOwn(theme.colors.tokens[mode], key)) {
      lines.push(`    <color key="${key}" value="${theme.colors.tokens[mode][key]}"/>`);
    }
    lines.push('  </tokens>');
  }
  if (theme.colors.metrics) {
    lines.push('  <metrics>');
    for (const key of Object.keys(THEME_METRICS)) if (Object.hasOwn(theme.colors.metrics, key)) {
      lines.push(`    <number key="${key}" value="${theme.colors.metrics[key]}"/>`);
    }
    lines.push('  </metrics>');
  }
  lines.push('</dds-theme>', '');
  const xml = lines.join('\n');
  byteLimit(xml, 'theme XML');
  return xml;
}

function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
const closed = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const colorProperties = keys => Object.fromEntries(keys.map(key => [key, { $ref: '#/$defs/color' }]));
export const THEME_SCHEMA = freezeTree({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/Altifigence/dds-plugin-sdk/blob/v0.2.0/schemas/theme.schema.json',
  title: 'DDS XML v2 theme input',
  $comment: 'parseTheme additionally enforces the 64 KiB UTF-8 budget, trimmed name length in UTF-16 code units and XML 1.0 character validity.',
  ...closed({
    name: { type: 'string', minLength: 1, maxLength: THEME_XML_MAX_BYTES,
      pattern: '^\\s*\\S(?:[\\s\\S]{0,78}\\S)?\\s*$',
      description: '1..80 UTF-16 code units after trimming; only XML 1.0 characters.' },
    colors: closed({
      light: { $ref: '#/$defs/palette' }, dark: { $ref: '#/$defs/palette' },
      tokens: closed({ light: { $ref: '#/$defs/tokens' }, dark: { $ref: '#/$defs/tokens' } }),
      metrics: closed(Object.fromEntries(Object.entries(THEME_METRICS).map(([key, value]) => [key, {
        type: value.integer ? 'integer' : 'number', minimum: value.min, maximum: value.max,
      }]))),
    }, modes),
  }, ['name', 'colors']),
  $defs: {
    color: { type: 'string', minLength: 7, maxLength: 7, pattern: '^#[0-9a-fA-F]{6}$' },
    palette: closed(colorProperties(THEME_COLOR_KEYS), THEME_COLOR_KEYS),
    tokens: closed(colorProperties(THEME_TOKEN_COLOR_KEYS)),
  },
});
