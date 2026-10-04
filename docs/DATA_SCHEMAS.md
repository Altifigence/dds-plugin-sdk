# Structured command data (SDK 0.12)

Commands may declare `inputSchema` and `outputSchema`, each using the version-1
envelope below. Existing `parameters` remain supported. Declaring both
`parameters` and `inputSchema` is an error; neither silently overrides the other.

```js
import {parseCommandInput, parseCommandOutput} from '@altifigence/dds-plugin-sdk';

const command = {
  id: 'summarize', title: 'Summarize',
  inputSchema: {schemaVersion: 1, schema: {
    type: 'object', additionalProperties: false,
    properties: {
      names: {type: 'array', minItems: 1, maxItems: 8,
        items: {type: 'string', minLength: 1, maxLength: 64}},
      count: {type: 'integer', minimum: 1, maximum: 10, default: 2},
    }, required: ['names', 'count'],
  }},
  outputSchema: {schemaVersion: 1, schema: {type: 'integer', minimum: 0}},
};
const input = parseCommandInput({names: ['Ada']}, command); // count becomes 2
parseCommandOutput(2, command);
```

The portable host applies defaults and validates inputs before invoking a handler
or starting a job. It validates outputs before publishing success. Output defaults
are never applied. A required output field must actually be returned. Job errors
retain a safe error code and omit invalid results. Existing primitive parameter
validation and commands without schemas retain their behavior.

| Node type | Supported fields besides `type` and `display` |
| --- | --- |
| `object` | `properties`, `required`, mandatory `additionalProperties: false`, `default` |
| `array` | mandatory `items`, `minItems`, `maxItems`, `default` |
| `string` | `minLength`, `maxLength`, `enum`, `default` |
| `number`, `integer` | `minimum`, `maximum`, `enum`, `default` |
| `boolean`, `null` | `enum`, `default` |
| Secret reference | `type: 'object', format: 'dds-secret-reference'`; no default |

Numbers must be finite; integers must be safe integers. String value lengths use
Unicode code points. Object property names use `[A-Za-z][A-Za-z0-9_.-]{0,127}`;
`constructor`, `prototype` and `__proto__` are forbidden. Unknown value fields,
unknown schema keywords, inconsistent ranges, duplicate enums and invalid defaults
are rejected. This subset has no `$ref`, remote retrieval, regex, union, coercion,
executable expression, HTML renderer or schema-supplied callback.

Defaults fill absent fields, including fields inside present nested objects. They
do not create a missing parent object unless that parent has its own valid default.
Defaults must be independently valid without further default expansion. References
cannot be placed in defaults, including through enclosing object/array defaults.
`null` is a value, not a request to apply a default or reset a setting.

`/data-schema` exports `parseDataSchema`, `validateDataValue` (defaults off unless
`{applyDefaults: true}`), `collectSecretReferences` and `describeDataForm`.
`DataValidationError` exposes `code`, `reason` and a JSON-pointer-like `path` using
known schema property names and array indices. Command helpers prefix paths with
`/input` or `/output`, for example `/input/options/names/0`. Unknown fields report
their parent path without echoing an arbitrary rejected key or value. HTTP errors
and retained job failures expose sanitized codes; run the public helpers locally
when a form needs a detailed field path.

Schemas are limited to 32 KiB, depth 8, 128 nodes, 64 properties per object and
64 primitive enum entries. Values and expanded defaults are limited to 64 KiB;
arrays to 256 items and strings to 16,384 code points. A complete command definition
including both schemas still has the existing 16 KiB metadata budget. Plain JSON
copying also has structural limits and rejects accessors, custom prototypes,
sparse arrays, cycles, invalid Unicode and non-JSON values without invoking hooks.

`display` contains literal `label`, `help`, `order`, `labelKey`, `helpKey` and
`accessibility` metadata. `describeDataForm` returns field paths, types, required
flags, choices, defaults and `secretReference` hints for a host-owned form. Array
item descriptions use `/*`. The host decides how to render and edit data; display
strings are never inserted as HTML. See [localization](LOCALIZATION.md).

Declare reference fields explicitly to use [execution-scoped secrets](SECRETS.md).
An ordinary string or an ordinary object resembling a reference conveys no secret
authority. See the [configuration example](../examples/configuration/run.mjs) for
actual HTTP commands and jobs, and `npm run example:configuration-browser` for forms.

New schema/display metadata requires a 0.12-aware host/client. Older strict
validators reject it. Keep legacy definitions when connecting older peers;
protocol version 1 does not imply support for every optional metadata extension.
