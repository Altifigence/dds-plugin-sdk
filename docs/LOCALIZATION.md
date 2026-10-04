# Localization and accessibility (SDK 0.12)

The `/localization` module validates caller-supplied catalogs and returns literal
display text. It does not fetch translations, load remote resources or execute
markup. Keep stable command IDs, settings keys, saved values and execution inputs
separate from the selected display language.

```js
import {parseLocaleCatalog, resolveMessage, localizeDisplay}
  from '@altifigence/dds-plugin-sdk/localization';

const catalog = parseLocaleCatalog({schemaVersion: 1, defaultLocale: 'en',
  messages: {
    en: {title: 'Run', finished: '{count} results'},
    ko: {title: '실행', finished: '결과 {count}개'},
    ar: {},
  }, fallbacks: {ar: ['en']},
});
const message = resolveMessage(catalog, 'ko-KR', 'finished', {count: 2});
// message.text, locale:'ko', requestedLocale:'ko-KR', fallback:true, direction:'ltr'
const display = localizeDisplay(catalog, 'ko', {
  labelKey: 'title', accessibility: {nameKey: 'title', shortcut: 'Control+Enter'},
});
```

Catalog locale keys and `defaultLocale` must be canonical BCP 47 base tags.
`canonicalLocale` canonicalizes user preferences. Unicode extensions/private-use
negotiation is unsupported. `negotiateLocale` accepts one preference or up to eight:
it tries each exact tag and progressively less specific ancestors, then the default.
Per-key lookup traverses the chosen locale's explicit fallback edges in declared
depth-first order, de-duplicates visited locales and finally tries the default.
Fallback targets must exist; cycles and outgoing edges from the default are errors.

The default catalog defines every valid key. Other locales may omit translations,
but may not introduce unknown keys. Every supplied translation must use exactly the
same placeholder names as its default message. The only interpolation syntax is
`{name}`; unmatched braces and ICU/plural expressions are rejected. Arguments must
match that set exactly and contain strings, finite numbers or booleans. Replacement
is one literal pass, so argument text containing braces is not reinterpreted.

`resolveMessage` reports the actual source locale, fallback flag and direction;
`formatMessage` returns just the text. Render with `textContent` or equivalent.
Apply `lang` and `dir` from the actual source to fallback text inside an RTL page.
`localeDirection` is a maximized-script layout hint for the documented implementation,
not font/shaping or complete writing-system conformance.

`formatLocaleNumber` supports decimal/percent, grouping and 0–10 fraction digits.
`formatLocaleDate` takes an explicit epoch and defaults to UTC with medium date style;
date/time styles and an explicit timezone can be supplied. `selectLocalePlural`
returns the host Intl cardinal/ordinal category; choose your own message key for
that category. Unsupported formatting locales or options fail explicitly. Hosts
own ICU/Intl availability; punctuation, numbering and timezone data can differ
between runtime versions. Persist raw values, not locale-formatted strings.

Optional manifest-v2 and command `display`, settings metadata and data-schema nodes
share `label/help/order`, locale keys and accessibility name/description/shortcut
hints. `validateLocalizedSurfaces(catalog, {manifest?, commands?, settings?, themes?})`
checks their keys and every available locale's resolved display bounds, and reports
missing translations. Static display fields cannot use placeholders. Themes use
explicit `{theme, display}` sidecars; the existing DDS theme JSON/XML is unchanged.
The catalog is an explicit module/file export selected by the operator, not an
implicit loader or a new manifest execution entry point.

Catalog limits are 256 KiB, 32 locales, 256 default keys, 4,096 UTF-16 units per
message, 32 placeholders and 16,384 units per formatted result. Display labels and
accessible names are additionally limited to 256 units, help/descriptions to 2,048.
Catalogs are frozen copies; accessors, prototypes, invalid Unicode and oversized
data are rejected before use. The example includes EN/KO, partial Arabic and a
deliberately long `en-XA` layout fixture. These are developer fixtures, not a claim
that DDS product UI or every supported Docs language has been translated.

## Bounded accessibility hints

`/accessibility` provides `normalizeShortcut`, `inspectAccessibility`,
`contrastRatio` and `inspectThemeContrast`. Shortcut metadata supports Control,
Alt, Shift and Meta plus a letter/digit, F1–F24 or an enumerated navigation key.
The inspector reports duplicate normalized shortcuts and missing resolved names
within up to 256 supplied surfaces. It neither binds keys nor knows conflicts
with operating-system shortcuts or another app.

Theme checks calculate unrounded contrast for explicitly listed opaque `#RRGGBB`
pairs in both palettes and available text/background token pairs. The default
threshold is 4.5, following the [W3C normal-text contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
and [sRGB luminance formula](https://www.w3.org/WAI/GL/wiki/Relative_luminance).
These are color-pair hints: they do not inspect rendered text, font size, opacity,
focus behavior, screen readers or certify complete UI accessibility.

Run `npm run example:configuration` for an independent HTTP consumer or
`npm run example:configuration-browser` for the local form. In the browser, choose
another language, save/reset a scoped value, try invalid names, revoke/renew the
disposable reference or hold a command while switching language. Continue within
30 seconds; timed-out work is cancelled. Ctrl+Enter invokes the same command.
