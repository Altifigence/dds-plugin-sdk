import {DataValidationError, configurationCopy, configurationFailure as fail, configurationObject as object, configurationInteger as integer, configurationKey as key, displayMetadata, freezeConfiguration, parseSecretReference} from './configuration-values.mjs';

export {DataValidationError, parseSecretReference, parseDisplayMetadata} from './configuration-values.mjs';
export const DATA_SCHEMA_LIMITS = Object.freeze({schemaBytes: 32_768, valueBytes: 65_536, depth: 8, nodes: 128, properties: 64, arrayItems: 256, stringCharacters: 16_384, enumItems: 64});
const parsed = new WeakSet();
const own = (value, name) => Object.hasOwn(value, name);
const primitive = value => value === null || ['boolean', 'string', 'number'].includes(typeof value);
const same = (a, b) => a === b;
const bounded = (value, maximum, path) => integer(value, maximum, 0, path);

function validate(node, value, path, applyDefaults) {
  if (value === undefined && applyDefaults && own(node, 'default')) value = node.default;
  const type = node.type;
  if (type === 'object' && node.format === 'dds-secret-reference') {
    try {return parseSecretReference(value);} catch {fail('secret_reference', path);}
  }
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('type', path);
    if (Object.keys(value).some(name => !own(node.properties, name))) fail('unknown_field', path);
    const result = {};
    for (const [name, child] of Object.entries(node.properties)) {
      if (own(value, name) || applyDefaults && own(child, 'default')) result[name] = validate(child, value[name], `${path}/${name}`, applyDefaults);
      else if (node.required?.includes(name)) fail('required', `${path}/${name}`);
    }
    return Object.freeze(result);
  }
  if (type === 'array') {
    if (!Array.isArray(value)) fail('type', path);
    if (value.length < (node.minItems ?? 0) || value.length > (node.maxItems ?? DATA_SCHEMA_LIMITS.arrayItems)) fail('range', path);
    return Object.freeze(value.map((item, index) => validate(node.items, item, `${path}/${index}`, applyDefaults)));
  }
  if (type === 'null' ? value !== null : type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== type) fail('type', path);
  if (type === 'string') {
    const count = [...value].length;
    if (count < (node.minLength ?? 0) || count > (node.maxLength ?? DATA_SCHEMA_LIMITS.stringCharacters)) fail('range', path);
  }
  if (type === 'number' || type === 'integer') {
    if (!Number.isFinite(value) || own(node, 'minimum') && value < node.minimum || own(node, 'maximum') && value > node.maximum) fail('range', path);
  }
  if (node.enum && !node.enum.some(item => same(item, value))) fail('enum', path);
  return value;
}

/** A closed, bounded JSON Schema subset. No remote references or executable expressions. */
export function parseDataSchema(input) {
  if (parsed.has(input)) return input;
  const value = configurationCopy(input, DATA_SCHEMA_LIMITS.schemaBytes);
  object(value, ['schemaVersion', 'schema']);
  if (value.schemaVersion !== 1) fail('schema_version', '/schemaVersion');
  let nodes = 0;
  function visit(node, path, depth) {
    if (++nodes > DATA_SCHEMA_LIMITS.nodes || depth > DATA_SCHEMA_LIMITS.depth) fail('budget', path, true);
    object(node, ['type'], ['properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'default', 'format', 'display'], path);
    if (!['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(node.type)) fail('type', `${path}/type`);
    const secret = node.type === 'object' && node.format === 'dds-secret-reference';
    const allowed = ['type', 'display', ...(!secret ? ['default'] : []), ...({object: secret ? ['format'] : ['properties', 'required', 'additionalProperties'], array: ['items', 'minItems', 'maxItems'], string: ['minLength', 'maxLength', 'enum'], number: ['minimum', 'maximum', 'enum'], integer: ['minimum', 'maximum', 'enum'], boolean: ['enum'], null: ['enum']}[node.type])];
    if (Object.keys(node).some(name => !allowed.includes(name))) fail('unsupported_keyword', path);
    if (own(node, 'display')) displayMetadata(node.display, `${path}/display`);
    if (node.type === 'object' && !secret) {
      if (node.additionalProperties !== false) fail('additional_properties', path);
      if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) fail('properties', path);
      const names = Object.keys(node.properties);
      if (names.length > DATA_SCHEMA_LIMITS.properties) fail('budget', path, true);
      for (const name of names) {key(name, `${path}/properties`); visit(node.properties[name], `${path}/properties/${name}`, depth + 1);}
      if (own(node, 'required')) {
        if (!Array.isArray(node.required) || node.required.length > names.length || new Set(node.required).size !== node.required.length || node.required.some(name => !names.includes(name))) fail('required', `${path}/required`);
      }
    } else if (node.type === 'array') {
      if (!own(node, 'items')) fail('items', path);
      visit(node.items, `${path}/items`, depth + 1);
      for (const name of ['minItems', 'maxItems']) if (own(node, name)) bounded(node[name], DATA_SCHEMA_LIMITS.arrayItems, `${path}/${name}`);
      if ((node.minItems ?? 0) > (node.maxItems ?? DATA_SCHEMA_LIMITS.arrayItems)) fail('range', path);
    } else if (node.type === 'string') {
      for (const name of ['minLength', 'maxLength']) if (own(node, name)) bounded(node[name], DATA_SCHEMA_LIMITS.stringCharacters, `${path}/${name}`);
      if ((node.minLength ?? 0) > (node.maxLength ?? DATA_SCHEMA_LIMITS.stringCharacters)) fail('range', path);
    } else if (node.type === 'number' || node.type === 'integer') {
      for (const name of ['minimum', 'maximum']) if (own(node, name) && (typeof node[name] !== 'number' || !Number.isFinite(node[name]) || node.type === 'integer' && !Number.isSafeInteger(node[name]))) fail('range', `${path}/${name}`);
      if (own(node, 'minimum') && own(node, 'maximum') && node.minimum > node.maximum) fail('range', path);
    }
    if (own(node, 'enum')) {
      if (!Array.isArray(node.enum) || node.enum.length < 1 || node.enum.length > DATA_SCHEMA_LIMITS.enumItems || node.enum.some(item => !primitive(item)) || new Set(node.enum).size !== node.enum.length) fail('enum', path);
      for (const item of node.enum) validate({...node, enum: undefined}, item, `${path}/enum`, false);
    }
    if (own(node, 'default')) {
      try {validate(node, node.default, `${path}/default`, false);} catch (error) {if (error instanceof DataValidationError) fail('default', `${path}/default`); throw error;}
      // Defaults must not smuggle an authority reference through an ordinary object.
      if (collect(node, node.default).length) fail('secret_default', `${path}/default`);
    }
  }
  visit(value.schema, '/schema', 0);
  parsed.add(value);
  return value;
}

export function validateDataValue(schema, input, options = {}) {
  object(options, [], ['applyDefaults']);
  const {applyDefaults = false} = options;
  schema = parseDataSchema(schema);
  if (typeof applyDefaults !== 'boolean') fail('options');
  const value = input === undefined && applyDefaults && own(schema.schema, 'default') ? undefined : configurationCopy(input, DATA_SCHEMA_LIMITS.valueBytes);
  // Recopy the expanded result to enforce total bytes/nodes after defaults too.
  return configurationCopy(validate(schema.schema, value, '', applyDefaults), DATA_SCHEMA_LIMITS.valueBytes);
}

function collect(node, value, path = '', output = []) {
  if (value === undefined) return output;
  if (node.format === 'dds-secret-reference') output.push(Object.freeze({path, reference: value}));
  else if (node.type === 'object') for (const [name, child] of Object.entries(node.properties)) {if (own(value, name)) collect(child, value[name], `${path}/${name}`, output);}
  else if (node.type === 'array') value.forEach((item, index) => collect(node.items, item, `${path}/${index}`, output));
  return output;
}
/** Only references in fields explicitly declared with the reference format. */
export function collectSecretReferences(schema, input) {
  schema = parseDataSchema(schema);
  return Object.freeze(collect(schema.schema, validateDataValue(schema, input)));
}

/** Literal metadata for host-owned forms; this function does not create UI. */
export function describeDataForm(schema) {
  schema = parseDataSchema(schema);
  const fields = [];
  const visit = (node, path, required) => {
    fields.push(freezeConfiguration({path, type: node.type, required, secretReference: node.format === 'dds-secret-reference', ...(node.display ? {display: node.display} : {}), ...(node.enum ? {choices: node.enum} : {}), ...(own(node, 'default') ? {default: node.default} : {})}));
    if (node.type === 'object' && !node.format) for (const [name, child] of Object.entries(node.properties)) visit(child, `${path}/${name}`, node.required?.includes(name) ?? false);
    if (node.type === 'array') visit(node.items, `${path}/*`, false);
  };
  visit(schema.schema, '', true);
  return Object.freeze(fields);
}
