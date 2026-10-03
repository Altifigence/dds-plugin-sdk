import { LIMITS } from './limits.mjs';
import { SEMVER_PATTERN } from './patterns.mjs';
import { THEME_SCHEMA } from './themes.mjs';

const schema = 'https://json-schema.org/draft/2020-12/schema';
const base = 'https://github.com/Altifigence/dds-plugin-sdk/blob/v0.2.0/schemas/';
const text = maxLength => ({type: 'string', minLength: 1, maxLength});
const integer = (maximum, minimum = 0) => ({type: 'integer', minimum, maximum});
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const list = (items, maxItems, minItems = 0, uniqueItems = false) => ({type: 'array', items, minItems, maxItems, ...(uniqueItems ? {uniqueItems: true} : {})});
const identifier = maxLength => ({...text(maxLength), pattern: '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$'});
const scope = object({projectId: text(128), sessionId: text(128)});
const identity = {
  uri: {...text(2048), pattern: '^[A-Za-z][A-Za-z0-9+.-]*:[^\\s\\u0000-\\u001f\\u007f]+$'},
  languageId: identifier(64), modelVersion: integer(Number.MAX_SAFE_INTEGER, 1), workspaceRevision: text(128),
};
const position = object({line: integer(LIMITS.documentBytes), character: integer(LIMITS.documentBytes)});
const diagnostic = object({
  range: object({start: position, end: position}),
  severity: {enum: ['error', 'warning', 'info', 'hint']},
  message: text(LIMITS.messageLength), code: text(128), source: text(128),
}, ['range', 'severity', 'message']);

const commonManifest = {
  id: identifier(128), name: text(128), publisher: identifier(128),
  version: {...text(64), pattern: SEMVER_PATTERN}, protocolVersion: {const: 1},
  entry: {...text(256), pattern: '^\\./(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.mjs$'},
};
const manifestV1 = object({
  manifestVersion: {const: 1}, ...commonManifest,
  capabilities: list({enum: ['diagnostics']}, 1, 1, true),
  permissions: list({enum: ['document.read', 'diagnostics.publish']}, 2, 0, true),
  supportedHosts: list({enum: ['test-host']}, 1, 1, true),
  license: {...text(128), pattern: '^[A-Za-z0-9.+-]+$'},
});
const manifestV2 = object({
  manifestVersion: {const: 2}, ...commonManifest, runtime: {enum: ['ui', 'workspace']},
  capabilities: list({enum: ['diagnostics', 'commands']}, 2, 1, true),
  permissions: list({enum: ['document.read', 'diagnostics.publish', 'workspace.read', 'workspace.write', 'backend.invoke']}, 5, 0, true),
  supportedHosts: list({enum: ['test-host', 'workspace-host']}, 2, 1, true),
  license: {...text(512), pattern: '^[A-Za-z0-9.+:()\\s-]+$', 'x-licenseExpression': true, $comment: 'Runtime validates bounded SPDX-style expression grammar; this is not legal permission.'},
  source: object({
    visibility: {enum: ['open', 'closed']},
    licenseFile: {...text(1024), pattern: '^(?:\\./)?(?!\\.{1,2}(?:/|$))[^/\\\\:\\u0000-\\u001f\\u007f]+(?:/(?!\\.{1,2}(?:/|$))[^/\\\\:\\u0000-\\u001f\\u007f]+)*$'},
    repository: {...text(2048), pattern: '^https://[^\\s?#]+$', format: 'uri', $comment: 'Runtime also rejects credentials.'},
  }, ['visibility', 'licenseFile']),
});
manifestV2.allOf = [{if: {properties: {runtime: {const: 'ui'}}}, then: {properties: {permissions: {items: {enum: ['document.read', 'diagnostics.publish']}}}}}];
const commandParameter = object({
  name: identifier(128), label: text(128), type: {enum: ['string', 'number', 'boolean']}, required: {type: 'boolean'},
  choices: list(text(256), 32, 1, true),
}, ['name', 'label', 'type', 'required']);
commandParameter.allOf = [{if: {required: ['choices']}, then: {properties: {type: {const: 'string'}}}}];

function define(name, body) {
  return {$schema: schema, $id: `${base}${name}.schema.json`, title: name, ...body};
}

/** Standard JSON Schemas. Runtime validators additionally enforce UTF-8 budgets and range ordering. */
export const SCHEMAS = Object.freeze({
  theme: THEME_SCHEMA,
  manifest: define('manifest', {properties: commonManifest, oneOf: [manifestV1, manifestV2]}),
  command: define('command', object({
    id: identifier(128), title: text(128), description: text(2048), parameters: list(commandParameter, 32),
  }, ['id', 'title'])),
  'json-value': define('json-value', {
    $ref: '#/$defs/value', 'x-maxUtf8Bytes': LIMITS.jsonBytes, 'x-maxDepth': LIMITS.jsonDepth, 'x-maxNodes': LIMITS.jsonNodes,
    $defs: {value: {anyOf: [
      {type: 'null'}, {type: 'boolean'}, {type: 'number'}, {type: 'string', maxLength: LIMITS.jsonBytes},
      {type: 'array', maxItems: LIMITS.jsonArrayItems, items: {$ref: '#/$defs/value'}},
      {type: 'object', maxProperties: LIMITS.jsonObjectProperties, propertyNames: text(128), additionalProperties: {$ref: '#/$defs/value'}},
    ]}},
  }),
  'diagnostics-request': define('diagnostics-request', object({
    protocolVersion: {const: 1}, requestId: text(128), scope,
    snapshot: object({...identity, text: {type: 'string', maxLength: LIMITS.documentBytes, 'x-maxUtf8Bytes': LIMITS.documentBytes}}),
  })),
  'diagnostics-result': define('diagnostics-result', object({
    protocolVersion: {const: 1}, requestId: text(128), scope, snapshot: object(identity),
    diagnostics: list(diagnostic, LIMITS.maxDiagnostics),
  })),
  error: define('error', object({
    code: {enum: ['invalid_contract', 'permission_denied', 'unsupported_host', 'version_mismatch', 'cancelled', 'stale_snapshot', 'budget_exceeded', 'disposed', 'provider_failed', 'provider_unavailable', 'capability_unavailable', 'conflict']},
    message: text(LIMITS.messageLength),
  })),
});
