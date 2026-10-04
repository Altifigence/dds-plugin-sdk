import {CODE_ACTION_KINDS, LANGUAGE_EDIT_LIMITS as limits} from './language-editing.mjs';
import {WORKSPACE_EDIT_SCHEMA} from './workspace-edit-schemas.mjs';
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const text = maximum => ({type: 'string', minLength: 1, maxLength: maximum});
const integer = (maximum, minimum = 0) => ({type: 'integer', minimum, maximum});
const list = (items, maxItems) => ({type: 'array', items, maxItems});
export const FORMATTING_OPTIONS_SCHEMA = object({tabSize: integer(limits.tabSize, 1), insertSpaces: {type: 'boolean'}, trimTrailingWhitespace: {type: 'boolean'}, insertFinalNewline: {type: 'boolean'}, trimFinalNewlines: {type: 'boolean'}, endOfLine: {enum: ['preserve', 'lf', 'crlf']}}, ['tabSize', 'insertSpaces']);
export const CODE_ACTION_CONTEXT_SCHEMA = object({triggerKind: {enum: ['invoked', 'automatic']}, only: {...list({enum: CODE_ACTION_KINDS}, CODE_ACTION_KINDS.length), minItems: 1, uniqueItems: true}}, ['triggerKind']);
export const CODE_ACTION_SCHEMA = {
  ...object({title: text(limits.title), kind: {enum: CODE_ACTION_KINDS}, isPreferred: {type: 'boolean'}, disabled: object({reason: text(limits.disabledReason)}), diagnosticIndices: {...list(integer(limits.diagnosticIndices - 1), limits.diagnosticIndices), uniqueItems: true}, edit: WORKSPACE_EDIT_SCHEMA, resolveData: {'x-maxUtf8Bytes': 4096}, resolveToken: {...text(36), pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'}}, ['title', 'kind']),
  allOf: [{if: {required: ['disabled']}, then: {properties: {edit: false, resolveData: false, resolveToken: false}}, else: {anyOf: [{required: ['edit']}, {required: ['resolveData']}, {required: ['resolveToken']}]}}],
  $comment: 'Runtime validates bounded JSON, diagnostics against the current bundle, action kinds against requested filters, and current-document edits. Host tokens cannot be supplied by providers. Labels, disabled reasons and other display text are never executable.',
};
export const LANGUAGE_EDITING_SCHEMAS = Object.freeze({'formatting-options': FORMATTING_OPTIONS_SCHEMA, 'code-action': CODE_ACTION_SCHEMA});
