import {parseJsonValue, parseScope, parseWorkspacePath} from './contracts.mjs';
import {parseJobId} from './jobs.mjs';
import {isSafeWorkspaceRelativePath} from './patterns.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';

export const BINARY_ARTIFACT_LIMITS = Object.freeze({fileBytes: 1_073_741_824, chunkBytes: 65_536, artifacts: 16, concurrent: 4});
const fail = () => {throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, 'Invalid binary artifact contract');};
const integer = (value, min, max) => {if (!Number.isSafeInteger(value) || value < min || value > max) fail(); return value;};
const text = (value, max = 128) => {if (typeof value !== 'string' || !value || value.length > max || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) fail(); return value;};
const sha = value => {if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value;};
function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const keys = Reflect.ownKeys(value);
  if (required.some(key => !Object.hasOwn(value, key)) || keys.length > required.length + optional.length) fail();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !required.includes(key) && !optional.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) fail();
  }
}

export function parseBinaryArtifact(value) {
  const v = parseJsonValue(value); exact(v, ['id', 'path', 'revision', 'byteLength'], ['label']);
  text(v.id); parseWorkspacePath(v.path); if (!isSafeWorkspaceRelativePath(v.path)) fail();
  sha(v.revision); integer(v.byteLength, 0, BINARY_ARTIFACT_LIMITS.fileBytes); if (v.label !== undefined) text(v.label, 256);
  return v;
}

export function parseBinaryArtifactReference(value) {
  const v = parseJsonValue(value); exact(v, ['jobId', 'scope', 'artifact']);
  parseJobId(v.jobId); parseScope(v.scope); parseBinaryArtifact(v.artifact); return v;
}

export function parseBinaryArtifactList(value) {
  const v = parseJsonValue(value); exact(v, ['jobId', 'scope', 'artifacts']); parseJobId(v.jobId); parseScope(v.scope);
  if (!Array.isArray(v.artifacts) || v.artifacts.length > BINARY_ARTIFACT_LIMITS.artifacts) fail();
  for (const artifact of v.artifacts) parseBinaryArtifact(artifact);
  if (new Set(v.artifacts.map(artifact => artifact.id)).size !== v.artifacts.length) fail(); return v;
}

export function parseBinaryArtifactCapabilities(value) {
  const v = parseJsonValue(value); exact(v, ['protocolVersion', 'enabled', 'limits']);
  if (v.protocolVersion !== 1 || typeof v.enabled !== 'boolean') fail(); exact(v.limits, Object.keys(BINARY_ARTIFACT_LIMITS));
  for (const [key, maximum] of Object.entries(BINARY_ARTIFACT_LIMITS)) integer(v.limits[key], 1, maximum);
  return v;
}

/** Strict canonical base64, bounded before allocation; usable in browsers and Node. */
export function decodeBinaryArtifactData(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(BINARY_ARTIFACT_LIMITS.chunkBytes / 3) * 4 || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  let decoded; try {decoded = atob(value);} catch {fail();}
  if (decoded.length > BINARY_ARTIFACT_LIMITS.chunkBytes || btoa(decoded) !== value) fail();
  return Uint8Array.from(decoded, character => character.charCodeAt(0));
}

export function parseBinaryArtifactRange(offset, length, byteLength = BINARY_ARTIFACT_LIMITS.fileBytes) {
  integer(byteLength, 0, BINARY_ARTIFACT_LIMITS.fileBytes);
  integer(offset, 0, byteLength); integer(length, 1, BINARY_ARTIFACT_LIMITS.chunkBytes);
  return Object.freeze({offset, length});
}

export function parseBinaryChunk(value, byteLength = BINARY_ARTIFACT_LIMITS.fileBytes) {
  const v = parseJsonValue(value); exact(v, ['offset', 'nextOffset', 'eof', 'data', 'sha256']);
  integer(v.offset, 0, byteLength); integer(v.nextOffset, v.offset, byteLength); sha(v.sha256);
  if (typeof v.eof !== 'boolean' || v.eof !== (v.nextOffset === byteLength)) fail();
  const bytes = decodeBinaryArtifactData(v.data);
  if (bytes.length !== v.nextOffset - v.offset || !bytes.length && !v.eof) fail(); return v;
}

export function parseBinaryArtifactChunk(value) {
  const v = parseJsonValue(value); exact(v, ['jobId', 'scope', 'artifact', 'offset', 'nextOffset', 'eof', 'data', 'sha256']);
  const {jobId, scope, artifact, ...chunk} = v;
  parseBinaryArtifactReference({jobId, scope, artifact}); parseBinaryChunk(chunk, artifact.byteLength); return v;
}

/** A trusted host port pins bytes once and rechecks its source on every chunk. */
export function parseBinaryArtifactSource(value, expectedPath) {
  exact(value, ['path', 'revision', 'byteLength', 'readChunk']);
  const {path, revision, byteLength, readChunk} = value;
  parseBinaryArtifact({id: 'source', path, revision, byteLength});
  if (path !== expectedPath || typeof readChunk !== 'function') fail();
  return Object.freeze({path, revision, byteLength, readChunk: readChunk.bind(value)});
}
