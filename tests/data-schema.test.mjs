import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDataSchema, validateDataValue, collectSecretReferences, describeDataForm, DataValidationError, DATA_SCHEMA_LIMITS} from '../src/data-schema.mjs';

const schema = node => ({schemaVersion: 1, schema: node});
const record = (properties, required = []) => ({type: 'object', properties, required, additionalProperties: false});
const code = (reason, path) => error => error instanceof DataValidationError && error.reason === reason && (path === undefined || error.path === path);

test('structured values validate nested objects and arrays, apply defaults and report known field paths', () => {
  const source = schema(record({count: {type: 'integer', minimum: 1, maximum: 10, default: 2}, rows: {type: 'array', minItems: 1, maxItems: 3, items: record({name: {type: 'string', minLength: 1, maxLength: 10}, enabled: {type: 'boolean', default: true}}, ['name', 'enabled'])}}, ['count', 'rows']));
  const parsed = parseDataSchema(source); source.schema.properties.count.default = 9;
  const value = validateDataValue(parsed, {rows: [{name: '界🌍'}]}, {applyDefaults: true});
  assert.deepEqual(value, {count: 2, rows: [{name: '界🌍', enabled: true}]}); assert.ok(Object.isFrozen(value.rows[0]));
  assert.throws(() => validateDataValue(parsed, {rows: []}, {applyDefaults: true}), code('range', '/rows'));
  assert.throws(() => validateDataValue(parsed, {count: 1, rows: [{}]}), code('required', '/rows/0/name'));
  assert.throws(() => validateDataValue(parsed, {count: 2, rows: [{name: 'x', enabled: false, privateRejectedKey: 'value'}]}), code('unknown_field', '/rows/0'));
  assert.throws(() => validateDataValue(parsed, {count: 1.1, rows: []}), code('type', '/count'));
});

test('the schema subset rejects unsupported keywords, invalid defaults and inconsistent enums', () => {
  for (const node of [
    {type: 'string', pattern: '.*'}, {type: 'string', $ref: 'https://example.invalid/schema'}, {type: 'object', properties: {}},
    {type: 'array'}, {type: 'array', items: {type: 'string'}, minItems: 2, maxItems: 1}, {type: 'number', minimum: Infinity},
    {type: 'integer', minimum: 1.5}, {type: 'string', enum: ['a', 'a']}, {type: 'string', enum: [1]},
    {type: 'string', default: 1}, {type: 'string', enum: ['a'], default: 'b'}, {type: 'boolean', display: null},
    record({name: {type: 'string'}}, ['missing']), {type: 'object', format: 'remote-reference'},
  ]) assert.throws(() => parseDataSchema(schema(node)), DataValidationError);
  assert.throws(() => parseDataSchema({...schema({type: 'null'}), schemaVersion: 2}), code('schema_version'));
  for (const [node, value] of [[{type: 'null', enum: [null]}, null], [{type: 'boolean', enum: [true]}, true], [{type: 'number', minimum: -2, maximum: 2}, 1.5]]) assert.equal(validateDataValue(schema(node), value), value);
});

test('plain JSON boundaries reject prototypes, accessors, cycles and nonfinite values without invoking hooks', () => {
  let calls = 0;
  for (const input of [{get type() {calls++; return 'string';}}, {type: 'string', toJSON() {calls++;}}, JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}},"additionalProperties":false}')]) assert.throws(() => parseDataSchema(schema(input)));
  const cycle = {}; cycle.self = cycle;
  for (const input of [NaN, Infinity, 1n, undefined, new Date(), cycle, [1, , 2], {get name() {calls++;}}]) assert.throws(() => validateDataValue(schema(record({name: {type: 'string'}})), input));
  assert.equal(calls, 0);
  assert.throws(() => validateDataValue(schema({type: 'string'}), '\ud800'), code('invalid_json'));
});

test('schema depth, node, value and expanded-default budgets remain bounded', () => {
  let deep = {type: 'string'};
  for (let i = 0; i < DATA_SCHEMA_LIMITS.depth + 1; i++) deep = {type: 'array', items: deep};
  assert.throws(() => parseDataSchema(schema(deep)), code('budget'));
  const expanded = schema({type: 'array', items: record({label: {type: 'string', default: 'x'.repeat(16_384)}}, ['label'])});
  assert.throws(() => validateDataValue(expanded, Array.from({length: 8}, () => ({})), {applyDefaults: true}), code('budget'));
  assert.throws(() => validateDataValue(schema({type: 'array', items: {type: 'null'}}), Array(257).fill(null)), code('range'));
  const many = Object.fromEntries(Array.from({length: 65}, (_, i) => ['field'+i, {type: 'null'}]));
  assert.throws(() => parseDataSchema(schema(record(many))), code('budget'));
});

test('secret references are explicit typed fields, not arbitrary strings, objects or defaults', () => {
  const ref = {kind: 'dds-secret-reference', id: crypto.randomUUID()};
  const reference = {type: 'object', format: 'dds-secret-reference'};
  const typed = schema(record({credentials: {type: 'array', items: reference}}, ['credentials']));
  assert.deepEqual(collectSecretReferences(typed, {credentials: [ref]}), [{path: '/credentials/0', reference: ref}]);
  assert.throws(() => validateDataValue(schema(reference), 'opaque-value'), code('secret_reference'));
  assert.throws(() => validateDataValue(schema(reference), {...ref, value: 'hidden'}), code('secret_reference'));
  assert.throws(() => parseDataSchema(schema({...reference, default: ref})));
  assert.throws(() => parseDataSchema(schema({...record({ref: reference}, ['ref']), default: {ref}})), code('secret_default'));
  const ordinary = schema(record({kind: {type: 'string'}, id: {type: 'string'}}));
  assert.deepEqual(collectSecretReferences(ordinary, ref), []);
});

test('form metadata stays literal, bounded and detached from schema input', () => {
  const s = schema(record({mode: {type: 'string', enum: ['safe', 'fast'], default: 'safe', display: {label: '<img src=x onerror=alert(1)>', help: 'Use {mode}', labelKey: 'mode.label', order: 2, accessibility: {name: 'Mode', descriptionKey: 'mode.help', shortcut: 'Alt+M'}}}}));
  const fields = describeDataForm(s);
  assert.equal(fields[1].path, '/mode'); assert.equal(fields[1].display.label, '<img src=x onerror=alert(1)>'); assert.deepEqual(fields[1].choices, ['safe', 'fast']);
  assert.ok(Object.isFrozen(fields[1].display.accessibility));
  assert.throws(() => parseDataSchema(schema({type: 'string', display: {html: '<b>bad</b>'}})));
});
