import {DATA_SCHEMA_LIMITS} from './data-schema.mjs';
import {SETTINGS_LIMITS} from './settings.mjs';

const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const text = (maxLength, minLength = 0) => ({type: 'string', minLength, maxLength});
const integer = (maximum, minimum = 0) => ({type: 'integer', minimum, maximum});
const array = (items, maxItems, minItems = 0) => ({type: 'array', items, minItems, maxItems});
const key = {...text(128, 1), pattern: '^(?!constructor$|prototype$|__proto__$)[A-Za-z][A-Za-z0-9_.-]{0,127}$'};
const pluginId = {...text(128, 1), pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'};
const uuid = {...text(36, 36), pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'};
export const SECRET_REFERENCE_SCHEMA = object({kind: {const: 'dds-secret-reference'}, id: uuid});
export const DISPLAY_METADATA_SCHEMA = object({label: text(256, 1), help: text(2048, 1), order: integer(10_000), labelKey: key, helpKey: key,
  accessibility: object({name: text(256, 1), description: text(2048, 1), nameKey: key, descriptionKey: key, shortcut: text(256, 1)}, []),
}, []);
const common = {display: DISPLAY_METADATA_SCHEMA};
const primitive = (type, additions, value) => object({type: {const: type}, ...common, ...additions, enum: {...array(value, DATA_SCHEMA_LIMITS.enumItems, 1), uniqueItems: true}, default: value}, ['type']);
const dataNode = {oneOf: [
  primitive('string', {minLength: integer(DATA_SCHEMA_LIMITS.stringCharacters), maxLength: integer(DATA_SCHEMA_LIMITS.stringCharacters)}, text(DATA_SCHEMA_LIMITS.stringCharacters)),
  ...['number', 'integer'].map(type => primitive(type, {minimum: {type}, maximum: {type}}, {type})),
  primitive('boolean', {}, {type: 'boolean'}), primitive('null', {}, {type: 'null'}),
  object({type: {const: 'array'}, ...common, items: {$ref: '#/$defs/dataNode'}, minItems: integer(DATA_SCHEMA_LIMITS.arrayItems), maxItems: integer(DATA_SCHEMA_LIMITS.arrayItems), default: array({}, DATA_SCHEMA_LIMITS.arrayItems)}, ['type', 'items']),
  object({type: {const: 'object'}, ...common, properties: {type: 'object', maxProperties: DATA_SCHEMA_LIMITS.properties, propertyNames: key, additionalProperties: {$ref: '#/$defs/dataNode'}}, additionalProperties: {const: false}, required: {...array(key, DATA_SCHEMA_LIMITS.properties), uniqueItems: true}, default: {type: 'object'}}, ['type', 'properties', 'additionalProperties']),
  object({type: {const: 'object'}, format: {const: 'dds-secret-reference'}, ...common}, ['type', 'format']),
]};
export const DATA_SCHEMA_CONTRACT = object({schemaVersion: {const: 1}, schema: {$ref: '#/$defs/dataNode'}});
export const DATA_SCHEMA_DEFINITIONS = Object.freeze({dataNode});
const withDataDefinitions = body => ({...body, $defs: DATA_SCHEMA_DEFINITIONS});
const values = {type: 'object', propertyNames: key, maxProperties: SETTINGS_LIMITS.keys};
const workspaceId = {...text(128, 1), pattern: '^(?!__proto__$|prototype$|constructor$)[^\\u0000-\\u001f\\u007f]+$'};
const layers = {user: values, workspaces: {type: 'object', maxProperties: SETTINGS_LIMITS.workspaces, propertyNames: workspaceId, additionalProperties: values}};
const setting = object({schema: DATA_SCHEMA_CONTRACT, scopes: {...array({enum: ['user', 'workspace']}, 2), uniqueItems: true}, readOnly: {type: 'boolean'}, display: DISPLAY_METADATA_SCHEMA}, ['schema', 'scopes']);
export const CONFIGURATION_SCHEMAS = Object.freeze({
  'data-schema': withDataDefinitions({...DATA_SCHEMA_CONTRACT, 'x-maxUtf8Bytes': DATA_SCHEMA_LIMITS.schemaBytes,
    $comment: 'Closed version-1 subset. Runtime enforces depth 8, 128 schema nodes, finite numbers/safe integers, matching required keys, range ordering, typed enums and valid defaults. No input $ref, pattern, union or external resolution. Reference defaults are forbidden, including nested references. Strings use Unicode code-point length. Values/default expansion are bounded to 64 KiB of plain JSON.'}),
  'display-metadata': {...DISPLAY_METADATA_SCHEMA, $comment: 'All fields are literal display data. Runtime additionally checks well-formed UTF-16 and rejects NUL. Locale key cross-checks are separate.'},
  'secret-reference': SECRET_REFERENCE_SCHEMA,
  'secret-scope': object({pluginId, workspaceId: text(128, 1), commandId: pluginId, executionId: uuid}),
  'settings-definition': withDataDefinitions({...object({schemaVersion: {const: 1}, pluginId, version: integer(Number.MAX_SAFE_INTEGER, 1), settings: {type: 'object', maxProperties: SETTINGS_LIMITS.keys, propertyNames: key, additionalProperties: setting}}), 'x-maxUtf8Bytes': SETTINGS_LIMITS.definitionBytes,
    $comment: 'Runtime validates each data schema. Read-only settings require a default and no writable scopes; other settings require at least one scope. Unknown/deleted keys never migrate implicitly.'}),
  'settings-state': {...object({schemaVersion: {const: 1}, pluginId, definitionVersion: integer(Number.MAX_SAFE_INTEGER, 1), revision: integer(Number.MAX_SAFE_INTEGER), ...layers}), 'x-maxUtf8Bytes': SETTINGS_LIMITS.stateBytes,
    $comment: 'An operator-owned memory store export. Import must match the selected plugin and definition version, validate each layer against the definition, reject read-only/scope overrides and bound each layer to 64 KiB. No secret resolver values are included.'},
  'settings-snapshot': {...object({schemaVersion: {const: 1}, pluginId, workspaceId, definitionVersion: integer(Number.MAX_SAFE_INTEGER, 1), revision: integer(Number.MAX_SAFE_INTEGER), values, sources: {type: 'object', maxProperties: SETTINGS_LIMITS.keys, propertyNames: key, additionalProperties: {enum: ['default', 'user', 'workspace']}}}), 'x-maxUtf8Bytes': SETTINGS_LIMITS.snapshotBytes,
    $comment: 'Runtime requires the same keys in values and sources. Host reads and notifications must match the active plugin and workspace. Default < user < workspace replaces an entire setting value. References are opaque identifiers, not secret values.'},
});
