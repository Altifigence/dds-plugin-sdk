import { LIMITS, ErrorCode } from './limits.mjs';
import {JOB_LIMITS, JOB_STATES} from './jobs.mjs';
import {BINARY_ARTIFACT_LIMITS} from './artifacts.mjs';
import {JOB_STORE_LIMITS} from './job-storage.mjs';
import {JOB_HISTORY_LIMITS} from './job-history.mjs';
import {ARTIFACT_STORE_LIMITS} from './artifact-storage.mjs';
import {PROJECT_WATCH_SCHEMAS} from './project-watch-schemas.mjs';
import { SEMVER_PATTERN } from './patterns.mjs';
import { THEME_SCHEMA } from './themes.mjs';
import {WORKSPACE_LIMITS} from './workspace-protocol.mjs';
import { LANGUAGE_FEATURES } from './contracts.mjs';

const schema = 'https://json-schema.org/draft/2020-12/schema';
const base = 'https://github.com/Altifigence/dds-plugin-sdk/blob/v0.8.0/schemas/';
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
  capabilities: list({enum: ['diagnostics', 'commands', ...LANGUAGE_FEATURES]}, 7, 1, true),
  permissions: list({enum: ['document.read', 'diagnostics.publish', 'workspace.read', 'workspace.write', 'backend.invoke', 'language.provide']}, 6, 0, true),
  supportedHosts: list({enum: ['test-host', 'workspace-host']}, 2, 1, true),
  license: {...text(512), pattern: '^[A-Za-z0-9.+:()\\s-]+$', 'x-licenseExpression': true, $comment: 'Runtime validates bounded SPDX-style expression grammar; this is not legal permission.'},
  source: object({
    visibility: {enum: ['open', 'closed']},
    licenseFile: {...text(1024), pattern: '^(?:\\./)?(?!\\.{1,2}(?:/|$))[^/\\\\:\\u0000-\\u001f\\u007f]+(?:/(?!\\.{1,2}(?:/|$))[^/\\\\:\\u0000-\\u001f\\u007f]+)*$'},
    repository: {...text(2048), pattern: '^https://[^\\s?#]+$', format: 'uri', $comment: 'Runtime also rejects credentials.'},
  }, ['visibility', 'licenseFile']),
});
manifestV2.allOf = [{if: {properties: {runtime: {const: 'ui'}}}, then: {properties: {permissions: {items: {enum: ['document.read', 'diagnostics.publish', 'language.provide']}}}}}];
const commandParameter = object({
  name: identifier(128), label: text(128), type: {enum: ['string', 'number', 'boolean']}, required: {type: 'boolean'},
  choices: list(text(256), 32, 1, true),
}, ['name', 'label', 'type', 'required']);
commandParameter.allOf = [{if: {required: ['choices']}, then: {properties: {type: {const: 'string'}}}}];

function define(name, body) {
  return {$schema: schema, $id: `${base}${name}.schema.json`, title: name, ...body};
}

const range = object({start: position, end: position});
const location = object({path: {...text(1024), $comment: 'Runtime additionally enforces a relative, traversal-free workspace path.'}, range});
const languageData = {
  completion: list(object({label: text(256), insertText: {type: 'string', maxLength: 16_384}, detail: text(2048), range}, ['label', 'insertText']), LIMITS.maxLanguageItems),
  hover: {oneOf: [{type: 'null'}, object({text: text(16_384), range}, ['text'])]},
  definition: list(location, LIMITS.maxLanguageItems), references: list(location, LIMITS.maxLanguageItems),
  'document-symbols': list(object({name: text(256), kind: {enum: ['module', 'namespace', 'class', 'interface', 'function', 'method', 'variable', 'constant', 'property', 'type']}, range, selectionRange: range, detail: text(2048)}, ['name', 'kind', 'range', 'selectionRange']), LIMITS.maxLanguageItems),
};

/** Standard JSON Schemas. Runtime validators additionally enforce UTF-8 budgets and range ordering. */
const jobId = {...text(36), pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
const jobProgress = object({completed: integer(Number.MAX_SAFE_INTEGER), total: integer(Number.MAX_SAFE_INTEGER, 1), message: {...text(JOB_LIMITS.messageBytes), 'x-maxUtf8Bytes': JOB_LIMITS.messageBytes}}, ['completed', 'total']);
const jobArtifact = object({id: text(128), path: {...text(1024), $comment: 'Runtime enforces the protected workspace file policy.'}, revision: {...text(64), pattern: '^[a-f0-9]{64}$'}, byteLength: integer(LIMITS.documentBytes), label: text(256)}, ['id', 'path', 'revision', 'byteLength']);
const jobBase = {protocolVersion: {const: 1}, jobId, scope, pluginId: text(128), commandId: text(128), startedAt: integer(Number.MAX_SAFE_INTEGER), updatedAt: integer(Number.MAX_SAFE_INTEGER), timeoutMs: integer(JOB_LIMITS.maxTimeoutMs, 1), progress: {oneOf: [{type: 'null'}, jobProgress]}, artifacts: list(jobArtifact, JOB_LIMITS.artifacts), lastSequence: integer(Number.MAX_SAFE_INTEGER, 1)};
const jobEvent = {oneOf: Object.entries({progress: jobProgress, artifact: jobArtifact, state: object({state: {enum: JOB_STATES}}), log: object({level: {enum: ['debug', 'info', 'warning', 'error']}, message: {...text(JOB_LIMITS.messageBytes), 'x-maxUtf8Bytes': JOB_LIMITS.messageBytes}})}).map(([kind, data]) => object({sequence: integer(Number.MAX_SAFE_INTEGER, 1), at: integer(Number.MAX_SAFE_INTEGER), kind: {const: kind}, data}))};
const fileRevision = {path: {...text(1024), $comment: 'Runtime enforces the protected relative workspace path policy.'}, revision: {...text(64), pattern: '^[a-f0-9]{64}$'}};
const binaryArtifact = object({...jobArtifact.properties, byteLength: integer(BINARY_ARTIFACT_LIMITS.fileBytes)}, ['id', 'path', 'revision', 'byteLength']);
const binaryReference = {jobId, scope, artifact: binaryArtifact};
const binaryChunk = {offset: integer(BINARY_ARTIFACT_LIMITS.fileBytes), nextOffset: integer(BINARY_ARTIFACT_LIMITS.fileBytes), eof: {type: 'boolean'}, data: {type: 'string', maxLength: Math.ceil(BINARY_ARTIFACT_LIMITS.chunkBytes / 3) * 4, contentEncoding: 'base64', pattern: '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'}, sha256: {...text(64), pattern: '^[a-f0-9]{64}$'}};
const storageSha = {...text(64), pattern: '^[a-f0-9]{64}$'};
const storeIdentity = {schemaVersion: {const: 1}, storeId: jobId, workspaceId: text(128), workspaceIdentity: storageSha};
const storeLimits = object(Object.fromEntries(Object.entries(JOB_STORE_LIMITS).map(([key, maximum]) => [key, ['recordBytes', 'pendingWrites'].includes(key) ? {const: maximum} : integer(maximum, 1)])));
const storedArtifact = object({...storeIdentity,snapshotId:jobId,jobId,pluginId:text(128),pluginArtifactSha256:storageSha,kind:{enum:['text','binary']},artifact:object({id:binaryArtifact.properties.id,path:binaryArtifact.properties.path,revision:storageSha,byteLength:integer(BINARY_ARTIFACT_LIMITS.fileBytes)}),capturedAt:integer(Number.MAX_SAFE_INTEGER),expiresAt:integer(Number.MAX_SAFE_INTEGER,1)});
storedArtifact.allOf=[{if:{properties:{kind:{const:'text'}}},then:{properties:{artifact:{properties:{byteLength:integer(LIMITS.documentBytes)}}}}}];
const storedReference=object({protocolVersion:{const:1},storage:{const:'snapshot'},scope,snapshot:storedArtifact});
const artifactStoreLimits=object(Object.fromEntries(Object.entries(ARTIFACT_STORE_LIMITS).map(([key,maximum])=>[key,integer(maximum,1)])));
const storedListEntry={oneOf:[object({kind:{enum:['text','binary']},artifact:storedArtifact.properties.artifact,storage:{const:'source'},availability:{const:'source-reference'},snapshot:{type:'null'}}),object({kind:{enum:['text','binary']},artifact:storedArtifact.properties.artifact,storage:{const:'snapshot'},availability:{enum:['retained','expired','missing','corrupt','unsupported']},snapshot:storedArtifact})]};
const storedJob = {...object({...storeIdentity, pluginArtifactSha256: storageSha, requestSha256: storageSha, revision: integer(Number.MAX_SAFE_INTEGER, 1), savedAt: integer(Number.MAX_SAFE_INTEGER), expiresAt: integer(Number.MAX_SAFE_INTEGER, 1), settled: {type: 'boolean'}, contentPolicy: {enum: ['metadata-only', 'host-redacted']}, grants: manifestV2.properties.permissions, snapshot: {$ref: base + 'job-snapshot.schema.json'}, events: list(jobEvent, JOB_LIMITS.events, 1), binaryArtifacts: list(binaryArtifact, JOB_LIMITS.artifacts), attemptOf: jobId,retainedArtifacts:list(storedArtifact,JOB_LIMITS.artifacts)}, [...Object.keys(storeIdentity), 'pluginArtifactSha256', 'requestSha256', 'revision', 'savedAt', 'expiresAt', 'settled', 'contentPolicy', 'grants', 'snapshot', 'events', 'binaryArtifacts']), 'x-maxUtf8Bytes': JOB_STORE_LIMITS.recordBytes, $comment: 'Runtime additionally enforces scope and identity, chronological contiguous events, shared artifact IDs, retention bounds, immutable metadata-only redaction and matching terminal state. Retained snapshot references bind exact registered artifacts and this job/workspace/plugin.'};
const historyDisposition = {enum:['live','completed','interrupted','expired']};
const historyCursor = {...text(40),pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:(?:0|[1-9][0-9]{0,2})$'};
const historyItem = object({jobId,commandId:text(128),state:{enum:JOB_STATES},disposition:historyDisposition,startedAt:integer(Number.MAX_SAFE_INTEGER),updatedAt:integer(Number.MAX_SAFE_INTEGER),expiresAt:integer(Number.MAX_SAFE_INTEGER,1),revision:integer(Number.MAX_SAFE_INTEGER,1),attemptOf:{oneOf:[jobId,{type:'null'}]},contentPolicy:{enum:['metadata-only','host-redacted']},artifactCount:integer(JOB_LIMITS.artifacts),snapshotCount:integer(JOB_LIMITS.artifacts),resultAvailability:{enum:['none','source-references','snapshot-references','mixed-references','expired']}});
export const SCHEMAS = Object.freeze({
  ...Object.fromEntries(Object.entries(PROJECT_WATCH_SCHEMAS).map(([name,body])=>[name,define(name,body)])),
  'stored-artifact':define('stored-artifact',{...storedArtifact,$comment:'Runtime checks identity, labels are excluded, and capturedAt/expiresAt ordering and maximum retention.'}),
  'stored-artifact-reference':define('stored-artifact-reference',{...storedReference,$comment:'Current response scope binds the workspace but does not reuse an old session.'}),
  'stored-artifact-chunk':define('stored-artifact-chunk',{...object({reference:storedReference,...binaryChunk}),$comment:'Runtime validates exact offsets/EOF, canonical base64 and content size. Hosts and clients verify chunk SHA-256; download publication verifies the whole file.'}),
  'stored-artifact-list':define('stored-artifact-list',{...object({protocolVersion:{const:1},scope,storeId:jobId,jobId,pluginId:text(128),pluginArtifactSha256:storageSha,disposition:{enum:['live','completed','interrupted','expired','missing','corrupt','unsupported']},artifacts:list(storedListEntry,JOB_LIMITS.artifacts)}),$comment:'Runtime enforces unique artifact IDs, matching embedded snapshot bindings and empty artifacts for unavailable jobs. Retained describes indexed metadata; get performs byte verification.'}),
  'artifact-storage-capabilities':define('artifact-storage-capabilities',{oneOf:[true,false].map(enabled=>object({protocolVersion:{const:1},enabled:{const:enabled},identity:enabled?object(storeIdentity):{type:'null'},limits:artifactStoreLimits}))}),
  'job-history-query': define('job-history-query', {...object({limit:integer(JOB_HISTORY_LIMITS.pageSize,1),state:{enum:JOB_STATES},disposition:historyDisposition,commandId:text(128),from:integer(Number.MAX_SAFE_INTEGER),to:integer(Number.MAX_SAFE_INTEGER),attemptOf:jobId,cursor:historyCursor},[]),$comment:'Default limit 16. Runtime checks cursor offset and inclusive time ordering. Cursor binds the normalized filters and current host generation.'}),
  'job-history-page': define('job-history-page', {...object({protocolVersion:{const:1},scope,storeId:jobId,pluginId:text(128),pluginArtifactSha256:storageSha,asOf:integer(Number.MAX_SAFE_INTEGER),expiresAt:integer(Number.MAX_SAFE_INTEGER,1),items:list(historyItem,JOB_HISTORY_LIMITS.pageSize),nextCursor:{oneOf:[historyCursor,{type:'null'}]}}),$comment:'Runtime additionally checks chronological bounds, descending startedAt and ascending jobId, unique IDs, retention states and a 60-second cursor lease.'}),
  'job-store-identity': define('job-store-identity', object(storeIdentity)),
  'stored-job': define('stored-job', storedJob),
  'job-storage-capabilities': define('job-storage-capabilities', {oneOf: [true, false].map(enabled => object({protocolVersion: {const: 1}, enabled: {const: enabled}, identity: enabled ? object(storeIdentity) : {type: 'null'}, limits: storeLimits}))}),
  'job-recovery': define('job-recovery', {oneOf: ['live', 'completed', 'interrupted', 'expired', 'missing', 'corrupt', 'unsupported'].map(disposition => object({protocolVersion: {const: 1}, jobId, scope, storeId: jobId, disposition: {const: disposition}, unrecordedTail: {const: disposition === 'completed' ? 'none' : 'unknown'}, record: ['live', 'completed', 'interrupted'].includes(disposition) ? storedJob : {type: 'null'}})), $comment: 'Runtime checks the record job/store/workspace binding and settled state. The current response scope does not replace the recorded original scope.'}),
  'binary-artifact': define('binary-artifact', binaryArtifact),
  'binary-artifact-reference': define('binary-artifact-reference', object(binaryReference)),
  'binary-artifact-list': define('binary-artifact-list', object({jobId, scope, artifacts: list(binaryArtifact, BINARY_ARTIFACT_LIMITS.artifacts)})),
  'binary-artifact-chunk': define('binary-artifact-chunk', {...object({...binaryReference, ...binaryChunk}), $comment: 'Runtime enforces canonical base64, exact decoded byte count, offsets/EOF and identity. Transfer clients verify chunk SHA-256; whole-file verification is required before publication.'}),
  'binary-artifact-capabilities': define('binary-artifact-capabilities', object({protocolVersion: {const: 1}, enabled: {type: 'boolean'}, limits: object(Object.fromEntries(Object.entries(BINARY_ARTIFACT_LIMITS).map(([key, value]) => [key, integer(value, 1)])))})),
  'workspace-file-capabilities': define('workspace-file-capabilities', object({protocolVersion: {const: 1}, revision: {type: 'boolean'}, conditionalRead: {type: 'boolean'}})),
  'workspace-file-revision': define('workspace-file-revision', object(fileRevision)),
  'workspace-conditional-file': define('workspace-conditional-file', {oneOf: [object({...fileRevision, notModified: {const: true}}), object({...fileRevision, notModified: {const: false}, content: {type: 'string', maxLength: WORKSPACE_LIMITS.fileBytes, 'x-maxUtf8Bytes': WORKSPACE_LIMITS.fileBytes}})], $comment: 'Runtime additionally correlates notModified and revision with the request knownRevision.'}),
  'job-options': define('job-options', object({jobId, timeoutMs: integer(JOB_LIMITS.maxTimeoutMs, 1)}, ['jobId'])),
  'job-snapshot': define('job-snapshot', {oneOf: [object({...jobBase, state: {const: 'running'}}), object({...jobBase, state: {const: 'succeeded'}, result: {$ref: `${base}json-value.schema.json`}}), object({...jobBase, state: {enum: ['failed', 'cancelled', 'timed_out']}, error: object({code: {enum: Object.values(ErrorCode)}})})], 'x-maxUtf8Bytes': LIMITS.jsonBytes, $comment: 'Runtime checks unique artifact IDs and cross-field time/progress ordering.'}),
  'job-events': define('job-events', object({jobId, scope, after: integer(Number.MAX_SAFE_INTEGER), nextCursor: integer(Number.MAX_SAFE_INTEGER), dropped: integer(Number.MAX_SAFE_INTEGER), hasMore: {type: 'boolean'}, events: list(jobEvent, JOB_LIMITS.pageSize)})),
  'job-artifact-content': define('job-artifact-content', object({jobId, scope, artifact: jobArtifact, content: {type: 'string', maxLength: LIMITS.documentBytes, 'x-maxUtf8Bytes': LIMITS.documentBytes}})),
  'job-capabilities': define('job-capabilities', object({protocolVersion: {const: 1}, enabled: {type: 'boolean'}, limits: object(Object.fromEntries(Object.entries(JOB_LIMITS).map(([key, value]) => [key, integer(value, 1)])))})),
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
  'language-request': define('language-request', {oneOf: LANGUAGE_FEATURES.map(kind => object({
    protocolVersion: {const: 1}, requestId: text(128), scope,
    snapshot: object({...identity, text: {type: 'string', maxLength: LIMITS.documentBytes, 'x-maxUtf8Bytes': LIMITS.documentBytes}}),
    kind: {const: kind}, ...(kind === 'document-symbols' ? {} : {position}), ...(kind === 'references' ? {includeDeclaration: {type: 'boolean'}} : {}),
  }, ['protocolVersion', 'requestId', 'scope', 'snapshot', 'kind', ...(kind === 'document-symbols' ? [] : ['position'])]))}),
  'language-result': define('language-result', {oneOf: LANGUAGE_FEATURES.map(kind => object({
    protocolVersion: {const: 1}, requestId: text(128), scope, snapshot: object(identity), kind: {const: kind}, data: languageData[kind],
  }))}),
  error: define('error', object({
    code: {enum: ['invalid_contract', 'permission_denied', 'unsupported_host', 'version_mismatch', 'cancelled', 'stale_snapshot', 'budget_exceeded', 'disposed', 'provider_failed', 'provider_unavailable', 'capability_unavailable', 'conflict']},
    message: text(LIMITS.messageLength),
  })),
});
