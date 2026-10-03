# A theme you can use in DDS

The [Hello Ocean example](../examples/hello-theme/theme.json) contains original
light and dark palettes, every supported semantic color and shape metrics.
It exports the XML v2 format that DDS already imports. Themes contain color
data and bounded numbers, so this path does not require executing a plugin or
connecting a backend.

From a clone of the public SDK repository, use Node.js 22 or 24:

```sh
node examples/hello-theme/export.mjs
```

Open `examples/hello-theme/preview.html` in a browser. It works locally without
a server, network access or dependencies. The preview is illustrative; DDS
supplies its own components, token defaults and accessibility settings.
The generated `hello-theme.xml` is included and ready to import.

## Install and apply

1. In DDS, open **Plugins → Install theme** and select `hello-theme.xml`.
2. Select **Apply** for **Hello Ocean** in the installed theme list.
3. Switch the appearance preference between light and dark to see both palettes.

Alternatively, open **Settings → Appearance → Import XML** and select the file.
That import becomes the custom theme on this device. Use **Export XML** to save
the current theme before replacing it. The customization editor's **Apply**
saves a draft, and **Cancel** preserves the applied theme. Choose a built-in
theme or import your saved XML to recover. A rejected XML file preserves the
current theme. Installation through Plugins and applying a listed theme are
separate steps; this SDK does not claim that it changed your device settings.

## Create your own theme

Edit `theme.json` and rerun the exporter. The public API also accepts a plain
object or bounded JSON text:

```js
import { parseTheme, serializeThemeXml } from '@altifigence/dds-plugin-sdk/themes';

const theme = parseTheme(savedJson);
const xml = serializeThemeXml(theme);
// Save xml as UTF-8, then select that file in DDS.
```

The JSON object has exactly `name` and `colors`. `colors` requires complete
`light` and `dark` palettes with `backdrop`, `navigation`, `tool`, `main`, `text`
and `muted`. Optional `colors.tokens.light` and `colors.tokens.dark` override
any of the 28 named semantic roles. Missing roles are derived by DDS from the
base palette. `searchBorder` remains a compatibility field; DDS search fields
are currently borderless.

`colors.metrics` optionally accepts integer `panelRadius` (0–24), integer
`controlRadius` (0–16), integer `popoverRadius` (0–24) and numeric
`popoverOpacity` (0.6–1). The current DDS default values are 14, 6, 16 and 0.72.
The SDK preserves omitted metrics so the target DDS release supplies its own
defaults. Set all four explicitly when you want a reproducible appearance.
Color values must be six-digit `#RRGGBB`; they are canonicalized to lowercase.
Names are trimmed to 1–80 UTF-16 code units and must contain valid XML 1.0
characters. JSON input and exported XML are each limited to 65,536 UTF-8 bytes.

See [theme.schema.json](../schemas/theme.schema.json), `THEME_TOKEN_COLOR_KEYS`
and `THEME_METRICS` for the full field inventory. `parseTheme()` returns an
independent, recursively frozen copy in a stable field order. The serializer
always emits XML v2, escapes name attributes and preserves optional overrides.
It does not parse XML or operate the DDS UI.

Unknown fields, inherited objects, accessors, invalid numbers, CSS color names,
alpha values, CSS variables, scripts and URLs in color values are rejected.
Neither API performs I/O or creates a plugin execution grant. They throw
`PluginSdkError` with `invalid_contract` or `budget_exceeded`.

The interoperable contract was checked against DDS commit `0f3e0d0189f1e23ce62205953bee04adbc9d54c9`.
The SDK implementation and Hello Ocean assets are original Apache-2.0 work;
the proprietary DDS theme parser, presets and renderer are not copied here.
