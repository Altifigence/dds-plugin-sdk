import type {JsonValue} from './index.mjs';
import {PluginSdkError} from './index.mjs';
export type SecretReference = {readonly kind: 'dds-secret-reference'; readonly id: string};
export interface AccessibilityMetadata {readonly name?: string; readonly description?: string; readonly nameKey?: string; readonly descriptionKey?: string; readonly shortcut?: string;}
export interface DisplayMetadata {readonly label?: string; readonly help?: string; readonly order?: number; readonly labelKey?: string; readonly helpKey?: string; readonly accessibility?: AccessibilityMetadata;}
interface DataNodeBase {readonly display?: DisplayMetadata;}
export type DataSchemaNode = DataNodeBase & (
  {readonly type: 'string'; readonly minLength?: number; readonly maxLength?: number; readonly enum?: readonly string[]; readonly default?: string} |
  {readonly type: 'number' | 'integer'; readonly minimum?: number; readonly maximum?: number; readonly enum?: readonly number[]; readonly default?: number} |
  {readonly type: 'boolean'; readonly enum?: readonly boolean[]; readonly default?: boolean} |
  {readonly type: 'null'; readonly enum?: readonly null[]; readonly default?: null} |
  {readonly type: 'array'; readonly items: DataSchemaNode; readonly minItems?: number; readonly maxItems?: number; readonly default?: readonly JsonValue[]} |
  {readonly type: 'object'; readonly properties: Readonly<Record<string, DataSchemaNode>>; readonly required?: readonly string[]; readonly additionalProperties: false; readonly default?: Readonly<Record<string, JsonValue>>} |
  {readonly type: 'object'; readonly format: 'dds-secret-reference'}
);
export interface DataSchema {readonly schemaVersion: 1; readonly schema: DataSchemaNode;}
export const DATA_SCHEMA_LIMITS: Readonly<{schemaBytes: number; valueBytes: number; depth: number; nodes: number; properties: number; arrayItems: number; stringCharacters: number; enumItems: number}>;
export class DataValidationError extends PluginSdkError {readonly reason: string; readonly path: string; constructor(reason: string, path?: string, budget?: boolean);}
export function parseDataSchema(value: unknown): DataSchema;
export function parseDisplayMetadata(value: unknown): DisplayMetadata;
export function parseSecretReference(value: unknown): SecretReference;
export function validateDataValue(schema: DataSchema, value: unknown, options?: {readonly applyDefaults?: boolean}): JsonValue;
export function collectSecretReferences(schema: DataSchema, value: unknown): readonly {readonly path: string; readonly reference: SecretReference}[];
export interface DataFormField {readonly path: string; readonly type: DataSchemaNode['type']; readonly required: boolean; readonly secretReference: boolean; readonly display?: DisplayMetadata; readonly choices?: readonly (null | boolean | number | string)[]; readonly default?: JsonValue;}
export function describeDataForm(schema: DataSchema): readonly DataFormField[];
