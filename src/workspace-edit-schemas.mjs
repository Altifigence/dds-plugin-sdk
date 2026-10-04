import {WORKSPACE_EDIT_LIMITS as limits} from './workspace-edit-contracts.mjs';
import {WORKSPACE_ERROR_CODES} from './workspace-values.mjs';
const object = (properties, required = Object.keys(properties)) => ({type: 'object', properties, required, additionalProperties: false});
const text = (maximum, minimum = 0) => ({type: 'string', minLength: minimum, maxLength: maximum});
const integer = maximum => ({type: 'integer', minimum: 0, maximum});
const list = (items, maxItems, minItems = 0) => ({type: 'array', items, minItems, maxItems});
const uuid = {...text(36, 36), pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$'};
const hash = {...text(64, 64), pattern: '^[a-f0-9]{64}$'};
const path = {...text(1024, 1), $comment: 'Runtime enforces the shared relative workspace path policy, protected components and cross-platform case-insensitive disjoint paths.'};
const content = {...text(262_144), 'x-maxUtf8Bytes': 262_144};
const position = object({line: integer(262_144), character: integer(262_144)});
const range = object({start: position, end: position});
const edit = object({range, text: content});
const change = {oneOf: ['edit', 'create', 'move', 'delete'].map(kind => {
  const fields = kind === 'edit' ? {baseRevision: hash, edits: list(edit, 500, 1)} : kind === 'create' ? {content} : kind === 'move' ? {baseRevision: hash, newPath: path} : {baseRevision: hash};
  return object({kind: {const: kind}, path, ...fields, reason: text(2048, 1)}, ['kind', 'path', ...Object.keys(fields)]);
})};
export const WORKSPACE_EDIT_SCHEMA = {...object({formatVersion: {const: 1}, id: uuid, title: text(256, 1), changes: list(change, limits.changes, 1)}), 'x-maxUtf8Bytes': limits.proposalBytes, $comment: 'At most 1000 edits in all files. Runtime validates paths, scalar strings and edit geometry. Revisions are full content SHA-256. Destinations must be absent, and affected paths cannot be duplicated or nested.'};
const fileState = {oneOf: [{type: 'null'}, object({content, revision: hash})]};
const pathState = object({path, state: fileState});
const workspace = object({id: uuid, generation: uuid});
const previewStep = object({index: integer(limits.changes - 1), before: list(pathState, 2, 1), after: {oneOf: [{type: 'null'}, list(pathState, 2, 1)]}, diff: list(object({path, change: object({start: integer(262_144), deleteCount: integer(262_144), insertText: content})}), 2)});
const preview = {...object({formatVersion: {const: 1}, planId: uuid, workspace, edit: WORKSPACE_EDIT_SCHEMA, requiredCapabilities: {enum: [['write'], ['write', 'manage']]}, ready: {type: 'boolean'}, conflicts: list(object({path, code: {enum: ['destination_exists', 'source_missing', 'revision_changed', 'no_change']}}), limits.changes * 2), steps: list(previewStep, limits.changes, 1), digest: hash}), 'x-maxUtf8Bytes': limits.previewBytes, $comment: 'Runtime reproduces the entire preview from before snapshots and proposal, verifies snapshot hashes and the canonical digest, UTF-16 ranges, overlap, after content and single-hunk diffs. A ready preview is required for apply.'};
const observed = ['applied', 'not-applied', 'conflicted', 'unknown'];
const recordStep = object({state: {enum: ['pending', 'intent', ...observed]}, errorCode: {enum: WORKSPACE_ERROR_CODES}}, ['state']);
export const WORKSPACE_EDIT_SCHEMAS = Object.freeze({
  'workspace-edit': WORKSPACE_EDIT_SCHEMA,
  'workspace-edit-preview': preview,
  'workspace-edit-record': {...object({formatVersion: {const: 1}, preview, revision: {...integer(Number.MAX_SAFE_INTEGER), minimum: 1}, phase: {enum: ['applying', 'completed', 'stopped']}, steps: list(recordStep, limits.changes, 1), updatedAt: integer(Number.MAX_SAFE_INTEGER)}), $comment: 'Runtime checks ready preview, exact step count, applied prefix/pending suffix, at most one intent and completed state. Node storage adds a checksum envelope and filesystem/workspace identity checks.'},
  'workspace-edit-receipt': object({formatVersion: {const: 1}, planId: uuid, digest: hash, workspaceId: uuid, status: {enum: ['completed', 'partial', 'not-applied', 'uncertain']}, steps: list(object({index: integer(limits.changes - 1), state: {enum: observed}, canCompensate: {type: 'boolean'}, errorCode: {enum: WORKSPACE_ERROR_CODES}}, ['index', 'state', 'canCompensate']), limits.changes, 1), executionStopped: {type: 'boolean'}, errorCode: {enum: WORKSPACE_ERROR_CODES}, journalError: {enum: WORKSPACE_ERROR_CODES}, currentGeneration: uuid, journalPhase: {enum: ['applying', 'completed', 'stopped']}, journalRevision: {...integer(Number.MAX_SAFE_INTEGER), minimum: 1}}, ['formatVersion', 'planId', 'digest', 'workspaceId', 'status', 'steps']),
});
