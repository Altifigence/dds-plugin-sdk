import {parseLocaleCatalog, resolveMessage, localizeDisplay, validateLocalizedSurfaces, formatLocaleNumber, formatLocaleDate, selectLocalePlural, type LocaleCatalog} from '@altifigence/dds-plugin-sdk/localization';
import {inspectAccessibility, inspectThemeContrast, contrastRatio} from '@altifigence/dds-plugin-sdk/accessibility';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';
const catalog: LocaleCatalog = parseLocaleCatalog({schemaVersion: 1, defaultLocale: 'en', messages: {en: {title: 'Run', count: '{count} files'}, ko: {title: '실행', count: '파일 {count}개'}}});
const result = resolveMessage(catalog, 'ko', 'count', {count: 3}); const direction: 'ltr' | 'rtl' = result.direction;
const display = localizeDisplay(catalog, 'ko', {labelKey: 'title', accessibility: {nameKey: 'title', shortcut: 'Control+Enter'}});
validateLocalizedSurfaces(catalog, {commands: [{id: 'run', title: 'Run', display}]});
inspectAccessibility([{id: 'run', display}]); inspectThemeContrast({}, {minimum: 4.5});
const ratio: number = contrastRatio('#000000', '#ffffff'); const category: Intl.LDMLPluralRule = selectLocalePlural('en', 2);
formatLocaleNumber('en', 0.25, {style: 'percent', maximumFractionDigits: 1}); formatLocaleDate('en', 0, {timeZone: 'UTC', dateStyle: 'long'});
// @ts-expect-error No executable or arbitrary rich-text argument values.
resolveMessage(catalog, 'en', 'count', {count: () => 1});
// @ts-expect-error Formatting options intentionally exclude currency selection.
formatLocaleNumber('en', 12, {currency: 'USD'});
// @ts-expect-error Dates require a caller-supplied epoch, not a platform-parsed string.
formatLocaleDate('en', '2026-10-04');
void direction; void ratio; void category; void SCHEMAS['locale-catalog']; void SCHEMAS['localized-message'];
