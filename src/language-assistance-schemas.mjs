import {LANGUAGE_LIMITS as limits} from './language-assistance.mjs';
import {LANGUAGE_FEATURES} from './contracts.mjs';
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const text = (maxLength, minLength = 0) => ({type: 'string', minLength, maxLength});
const integer = (maximum, minimum = 0) => ({type: 'integer', minimum, maximum});
const list = (items, maxItems, minItems = 0) => ({type: 'array', items, minItems, maxItems});
const position = object({line: integer(262_144), character: integer(262_144)});
const range = object({start: position, end: position});
const edit = object({range, text: text(16_384)});
const token = {...text(36, 36), pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'};
export const COMPLETION_ITEM_SCHEMA = {
  ...object({label: text(256, 1), insertText: text(16_384), detail: text(2048, 1), range,
    documentation: text(limits.documentation), insertTextFormat: {enum: ['literal', 'snippet']}, additionalTextEdits: list(edit, limits.additionalEdits),
    resolveData: {'x-maxUtf8Bytes': limits.resolveDataBytes, $comment: 'Bounded plain JSON. The host retains this provider data privately and issues a one-use opaque token.'}, resolveToken: token,
  }, ['label', 'insertText']),
  $comment: 'Runtime checks well-formed UTF-16, exact snippet grammar, expanded text, document ranges, non-overlap and final file size. Provider-supplied resolveToken is rejected by the registry. Resolution cannot change label/insertion/format/range.',
};
const parameter = object({label: {...list(integer(limits.signatureLabel), 2, 2), $comment: 'Ordered nonempty UTF-16 label offsets within the signature, without split Unicode characters.'}, documentation: text(limits.documentation)}, ['label']);
export const SIGNATURE_HELP_SCHEMA = {oneOf: [{type: 'null'}, object({signatures: list(object({label: text(limits.signatureLabel, 1), parameters: list(parameter, limits.parameters), documentation: text(limits.documentation)}, ['label', 'parameters']), limits.signatures, 1), activeSignature: integer(limits.signatures - 1), activeParameter: {oneOf: [integer(limits.parameters - 1), {type: 'null'}]}})], $comment: 'Runtime additionally checks active indices; activeParameter is null only for the selected signature with no parameters.'};
export function languageContextSchema(kind) {
  const signature = kind === 'signature-help';
  return {oneOf: (signature ? ['invoked', 'character', 'content-change'] : ['invoked', 'character', 'incomplete']).map(triggerKind => object({triggerKind: {const: triggerKind}, ...(triggerKind === 'character' ? {triggerCharacter: text(1, 1)} : {}), ...(signature ? {isRetrigger: {type: 'boolean'}, activeSignature: integer(limits.signatures - 1), activeParameter: integer(limits.parameters - 1)} : {})}, ['triggerKind', ...(triggerKind === 'character' ? ['triggerCharacter'] : []), ...(signature ? ['isRetrigger'] : [])]))};
}
export const LANGUAGE_ASSISTANCE_SCHEMAS = Object.freeze({
  'completion-item': COMPLETION_ITEM_SCHEMA,
  'signature-help': SIGNATURE_HELP_SCHEMA,
  'language-snippet': {...text(limits.snippetChars), $comment: 'Runtime accepts $n, ${n}, ${n:literal}, one $0 and escapes for backslash/dollar/braces. Indices are 0..99; no variables, nesting, choices or transforms. Mirrored defaults must agree; expansion is <=16384 UTF-16 units and <=128 explicit stops.'},
  'language-capabilities': object({protocolVersion: {const: 1}, features: {const: LANGUAGE_FEATURES}, completionResolve: {const: true}, codeActionResolve: {const: true}, snippets: {const: true}, positions: {const: 'utf16-zero-based'}, limits: object(Object.fromEntries(Object.entries(limits).map(([key, value]) => [key, {const: value}])))}),
});
