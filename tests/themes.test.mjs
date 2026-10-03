// SPDX-FileCopyrightText: 2026 Altifigence
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  parseTheme, serializeThemeXml, THEME_XML_MAX_BYTES, THEME_COLOR_KEYS,
  THEME_TOKEN_COLOR_KEYS, THEME_METRICS, THEME_SCHEMA,
} from '../src/themes.mjs';
import { PluginSdkError } from '../src/limits.mjs';

const example = () => JSON.parse(readFileSync(new URL('../examples/hello-theme/theme.json', import.meta.url), 'utf8'));
const invalid = action => assert.throws(action, error => error instanceof PluginSdkError && error.code === 'invalid_contract');
const budget = action => assert.throws(action, error => error instanceof PluginSdkError && error.code === 'budget_exceeded');
const reverse = record => Object.fromEntries(Object.entries(record).reverse());

test('theme validator copies, normalizes and recursively freezes the complete DDS color contract', () => {
  const input = example();
  input.name = '  Hello Ocean  ';
  input.colors.light.main = '#AaBBcC';
  input.colors.tokens.dark.gdsBackground = '#AaBBcC';
  const theme = parseTheme(input);
  assert.equal(theme.name, 'Hello Ocean');
  assert.equal(theme.colors.light.main, '#aabbcc');
  assert.equal(theme.colors.tokens.dark.gdsBackground, '#aabbcc');
  assert.equal(THEME_COLOR_KEYS.length, 6);
  assert.equal(THEME_TOKEN_COLOR_KEYS.length, 28);
  assert.deepEqual(Object.keys(theme.colors.tokens.light), THEME_TOKEN_COLOR_KEYS);
  assert.deepEqual(Object.keys(theme.colors.tokens.dark), THEME_TOKEN_COLOR_KEYS);
  for (const value of [theme, theme.colors, theme.colors.light, theme.colors.dark, theme.colors.tokens,
    theme.colors.tokens.light, theme.colors.tokens.dark, theme.colors.metrics]) assert.ok(Object.isFrozen(value));
  input.colors.dark.main = '#ffffff';
  input.colors.metrics.panelRadius = 0;
  assert.equal(theme.colors.dark.main, '#1c3949');
  assert.equal(theme.colors.metrics.panelRadius, 16);
  assert.throws(() => { theme.colors.dark.main = '#ffffff'; }, TypeError);
  assert.deepEqual(parseTheme(JSON.stringify(theme)), theme);
});

test('XML v2 serialization is stable across JSON property order and preserves every semantic role', () => {
  const input = example();
  const xml = serializeThemeXml(input);
  const reordered = { colors: { metrics: reverse(input.colors.metrics),
    tokens: { dark: reverse(input.colors.tokens.dark), light: reverse(input.colors.tokens.light) },
    dark: reverse(input.colors.dark), light: reverse(input.colors.light) }, name: input.name };
  assert.equal(serializeThemeXml(reordered), xml);
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<dds-theme version="2" name="Hello Ocean">/);
  assert.match(xml, /<\/dds-theme>\n$/);
  assert.equal((xml.match(/<palette /g) ?? []).length, 2);
  assert.equal((xml.match(/<tokens /g) ?? []).length, 2);
  assert.equal((xml.match(/<color /g) ?? []).length, 68);
  assert.equal((xml.match(/<number /g) ?? []).length, 4);
  assert.ok(new TextEncoder().encode(xml).length < THEME_XML_MAX_BYTES);
  assert.doesNotMatch(xml, /<!DOCTYPE|<!ENTITY|xmlns|<script|style=/);
  for (const mode of ['light', 'dark']) {
    for (const key of THEME_COLOR_KEYS) assert.ok(xml.includes(`<color key="${key}" value="${input.colors[mode][key]}"/>`));
    for (const key of THEME_TOKEN_COLOR_KEYS) assert.ok(xml.includes(`<color key="${key}" value="${input.colors.tokens[mode][key]}"/>`));
  }
});

test('minimal palettes and empty optional overrides remain valid XML v2 data', () => {
  const input = example();
  delete input.colors.tokens;
  delete input.colors.metrics;
  const minimal = parseTheme(input);
  assert.deepEqual(Object.keys(minimal.colors), ['light', 'dark']);
  assert.match(serializeThemeXml(minimal), /<dds-theme version="2"/);
  assert.doesNotMatch(serializeThemeXml(minimal), /<tokens|<metrics/);
  input.colors.tokens = { dark: {} };
  input.colors.metrics = {};
  const xml = serializeThemeXml(input);
  assert.match(xml, /<tokens mode="dark">\n  <\/tokens>/);
  assert.match(xml, /<metrics>\n  <\/metrics>/);
});

test('metric limits accept their endpoints and reject units, fractions and non-finite values', () => {
  for (const endpoint of ['min', 'max']) {
    const input = example();
    input.colors.metrics = Object.fromEntries(Object.entries(THEME_METRICS).map(([key, value]) => [key, value[endpoint]]));
    assert.deepEqual(parseTheme(input).colors.metrics, input.colors.metrics);
  }
  for (const [key, values] of [
    ['panelRadius', [-1, 25, 1.5, '16px', null, NaN, Infinity]],
    ['controlRadius', [-1, 17, 1.5]], ['popoverRadius', [-1, 25, 1.5]],
    ['popoverOpacity', [0.59, 1.01, '0.9', NaN, -Infinity]],
  ]) for (const value of values) {
    const input = example(); input.colors.metrics[key] = value;
    invalid(() => parseTheme(input));
  }
  const input = example(); input.colors.metrics.panelRadius = -0; input.colors.metrics.popoverOpacity = 0.675;
  assert.equal(Object.is(parseTheme(input).colors.metrics.panelRadius, -0), false);
  assert.match(serializeThemeXml(input), /key="panelRadius" value="0"/);
  assert.match(serializeThemeXml(input), /key="popoverOpacity" value="0.675"/);
});

test('theme names retain XML characters safely, escape attributes and use the host UTF-16 length rule', () => {
  const input = example(); input.name = '  A & <B> "C" \'D\'\tE\nF\rG  ';
  assert.equal(parseTheme(input).name, 'A & <B> "C" \'D\'\tE\nF\rG');
  assert.match(serializeThemeXml(input), /name="A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;&#9;E&#10;F&#13;G"/);
  input.name = '😀'.repeat(40); assert.equal(parseTheme(input).name.length, 80);
  for (const name of ['', ' \t\n ', 'x'.repeat(81), '😀'.repeat(41), 'invalid\0name', 'bad\u000bname', '\ud800', '\udfff', 'bad\ufffename']) {
    input.name = name; invalid(() => parseTheme(input));
  }
});

test('theme JSON enforces the exact UTF-8 budget before parsing and never stringifies caller hooks', () => {
  const json = JSON.stringify(example());
  const bytes = new TextEncoder().encode(json).length;
  const atLimit = ' '.repeat(THEME_XML_MAX_BYTES - bytes) + json;
  assert.equal(new TextEncoder().encode(atLimit).length, THEME_XML_MAX_BYTES);
  assert.equal(parseTheme(atLimit).name, 'Hello Ocean');
  budget(() => parseTheme(' ' + atLimit));
  budget(() => parseTheme('\u3000'.repeat(22_000) + json));
  const input = example(); input.name = ' '.repeat(THEME_XML_MAX_BYTES) + 'x';
  budget(() => parseTheme(input));
  invalid(() => parseTheme('{invalid JSON'));
  let calls = 0;
  input.name = 'Safe'; input.toJSON = () => { calls++; throw new Error('must not execute'); };
  invalid(() => parseTheme(input));
  assert.equal(calls, 0);
});

test('unknown fields, JavaScript/CSS/URLs and non-hex colors cannot enter a theme', () => {
  const changes = [
    input => { input.css = 'body { display: none }'; },
    input => { input.script = 'alert(1)'; },
    input => { input.url = 'https://example.test/theme.css'; },
    input => { delete input.colors.light.main; },
    input => { input.colors.light.extra = '#123456'; },
    input => { input.colors.tokens.dark.unknownRole = '#123456'; },
    input => { input.colors.tokens.auto = {}; },
    input => { input.colors.metrics.width = 100; },
    input => { input.colors.light = Object.create(input.colors.light); },
    input => { input[Symbol('hidden')] = true; },
    input => { Object.defineProperty(input, 'name', {value: 'Hidden', enumerable: false}); },
  ];
  for (const change of changes) { const input = example(); change(input); invalid(() => parseTheme(input)); }
  for (const color of ['red', '#fff', '#112233ff', '#112233\n', '#112233 ', 'var(--main)', 'url(https://example.test/a)', 'javascript:alert(1)', '<script>', 123456, null]) {
    const input = example(); input.colors.dark.main = color; invalid(() => serializeThemeXml(input));
  }
  invalid(() => parseTheme(JSON.stringify(example()).replace('"main":', '"__proto__":')));
});

test('accessors are rejected without invocation; null-prototype JSON records remain portable', () => {
  let calls = 0;
  for (const target of ['root', 'palette', 'tokens', 'metrics']) {
    const input = example();
    const [object, key] = target === 'root' ? [input, 'colors'] : target === 'palette' ? [input.colors.light, 'main']
      : target === 'tokens' ? [input.colors.tokens.dark, 'search'] : [input.colors.metrics, 'panelRadius'];
    Object.defineProperty(object, key, {enumerable: true, get() { calls++; throw new Error('must not execute'); }});
    invalid(() => parseTheme(input));
  }
  assert.equal(calls, 0);
  const nullObjects = value => value && typeof value === 'object'
    ? Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([key, item]) => [key, nullObjects(item)]))) : value;
  assert.deepEqual(parseTheme(nullObjects(example())), parseTheme(example()));
});

test('checked-in theme schema and examples match the public validators and exporter', async () => {
  assert.equal(readFileSync(new URL('../schemas/theme.schema.json', import.meta.url), 'utf8'), `${JSON.stringify(THEME_SCHEMA, null, 2)}\n`);
  assert.deepEqual(THEME_SCHEMA.$defs.palette.required, THEME_COLOR_KEYS);
  assert.deepEqual(Object.keys(THEME_SCHEMA.$defs.tokens.properties), THEME_TOKEN_COLOR_KEYS);
  assert.equal(THEME_SCHEMA.additionalProperties, false);
  assert.ok(Object.isFrozen(THEME_SCHEMA.$defs.palette.properties));
  const theme = example();
  assert.equal(readFileSync(new URL('../examples/hello-theme/hello-theme.xml', import.meta.url), 'utf8'), serializeThemeXml(theme));
  const { renderPreview } = await import('../examples/hello-theme/export.mjs');
  const preview = renderPreview(theme);
  assert.equal(readFileSync(new URL('../examples/hello-theme/preview.html', import.meta.url), 'utf8'), preview);
  assert.match(preview, /script-src 'none'/);
  assert.match(preview, /href="hello-theme.xml" download/);
  assert.match(preview, /id="light"/);
  assert.match(preview, /id="dark"/);
  assert.doesNotMatch(preview, /<script|https?:\/\/|<iframe|<link[^>]+href=/);
  theme.name = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(renderPreview(theme), /<img src=x/);
  assert.match(renderPreview(theme), /&lt;img src=x onerror=alert\(1\)&gt;/);
});
