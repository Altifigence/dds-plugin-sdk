import {configurationCopy as copy, configurationObject as object, configurationFailure as fail, configurationText as text, parseDisplayMetadata, freezeConfiguration as freeze} from './configuration-values.mjs';
import {parseTheme} from './themes.mjs';

const modifiers = ['Control', 'Alt', 'Shift', 'Meta'];
const keys = ['Enter', 'Space', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ...Array.from({length: 24}, (_, i) => 'F' + (i + 1))];
/** Portable metadata only. Hosts own keyboard routing and platform conflicts. */
export function normalizeShortcut(input) {
  text(input, 256);
  const parts = input.split('+').map(part => part.trim());
  if (!parts.length || parts.length > 5) fail('shortcut');
  const final = parts.pop(), main = /^[a-z0-9]$/i.test(final) ? final.toUpperCase() : keys.find(key => key.toLowerCase() === final.toLowerCase());
  const selected = parts.map(part => modifiers.find(modifier => modifier.toLowerCase() === part.toLowerCase()));
  if (!main || selected.includes(undefined) || new Set(selected).size !== selected.length) fail('shortcut');
  return [...modifiers.filter(modifier => selected.includes(modifier)), main].join('+');
}
export function inspectAccessibility(input) {
  const surfaces = copy(input, 262_144);
  if (!Array.isArray(surfaces) || surfaces.length > 256) fail('budget', '', true);
  const identities = new Set(), shortcuts = new Map(), issues = [];
  for (const surface of surfaces) {
    object(surface, ['id', 'display']); text(surface.id, 256); const display = parseDisplayMetadata(surface.display);
    if (identities.has(surface.id)) fail('duplicate_surface'); identities.add(surface.id);
    if (!(display.accessibility?.name ?? display.label)?.trim()) issues.push({id: surface.id, code: 'missing_name'});
    if (display.accessibility?.shortcut) {
      const shortcut = normalizeShortcut(display.accessibility.shortcut);
      if (!shortcuts.has(shortcut)) shortcuts.set(shortcut, []); shortcuts.get(shortcut).push(surface.id);
    }
  }
  const conflicts = [...shortcuts].filter(([, ids]) => ids.length > 1).map(([shortcut, ids]) => ({shortcut, ids}));
  return freeze({issues, conflicts});
}
function luminance(color) {
  if (typeof color !== 'string' || !/^#[a-f0-9]{6}$/i.test(color)) fail('color');
  const values = [1, 3, 5].map(start => parseInt(color.slice(start, start + 2), 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
}
export function contrastRatio(foreground, background) {
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
/** Checks these explicit opaque-color pairs only; this is not UI conformance. */
export function inspectThemeContrast(input, options = {}) {
  const theme = parseTheme(input); options = copy(options, 1024); object(options, [], ['minimum']);
  const minimum = options.minimum ?? 4.5;
  if (typeof minimum !== 'number' || !Number.isFinite(minimum) || minimum < 1 || minimum > 21) fail('contrast_threshold');
  const checks = [];
  for (const mode of ['light', 'dark']) {
    const palette = theme.colors[mode], tokens = theme.colors.tokens?.[mode] ?? {};
    const add = (foreground, background, colors, prefix = '') => {
      const ratio = contrastRatio(colors[foreground], colors[background]);
      checks.push({mode, foreground: prefix + foreground, background: prefix + background, ratio, minimum, passes: ratio >= minimum});
    };
    for (const [foreground, background] of [['text', 'main'], ['muted', 'main'], ['text', 'navigation'], ['text', 'tool'], ['text', 'backdrop']]) add(foreground, background, palette);
    for (const [foreground, background] of [['searchText', 'search'], ['selectionText', 'selection'], ['hintsBoxText', 'hintsBoxBackground'], ['hintsBoxSelectedText', 'hintsBoxSelectedBackground']]) if (tokens[foreground] && tokens[background]) add(foreground, background, tokens, 'tokens.');
  }
  return freeze({checks, failures: checks.filter(check => !check.passes).length});
}
