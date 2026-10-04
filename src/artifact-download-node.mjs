import * as fs from 'node:fs/promises';
import {constants as flags} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BINARY_ARTIFACT_LIMITS, parseBinaryArtifactReference, parseBinaryArtifactChunk, decodeBinaryArtifactData} from './artifacts.mjs';
import {WORKSPACE_LIMITS, WorkspaceError, workspaceFailure, exactObject} from './workspace-protocol.mjs';

const active = new Set();
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameState = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sameArtifact = (a, b) => ['id', 'path', 'revision', 'byteLength', 'label'].every(key => a[key] === b[key]);
const regular = value => {if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1n) throw workspaceFailure('unsafe_path', 'Download staging file must be a regular file with one link');};
async function optionalStat(target) {try {return await fs.lstat(target, {bigint: true});} catch (error) {if (error.code !== 'ENOENT') throw error;}}
function localError(error) {
  if (error instanceof WorkspaceError) return error;
  const code = error?.code;
  if (code === 'EEXIST') return workspaceFailure('conflict', 'Download destination already exists');
  if (['EACCES', 'EPERM'].includes(code)) return workspaceFailure('permission_denied', 'Download file access denied');
  return workspaceFailure('unavailable', 'Download file operation failed');
}

/** Download through a connected SDK client. Only verified complete bytes are published. */
export async function downloadJobBinaryArtifact(client, reference, options) {
  reference = parseBinaryArtifactReference(reference);
  exactObject(options, ['destination'], ['resume', 'signal', 'timeoutMs', 'requestTimeoutMs', 'onProgress']);
  const {destination, resume = false, signal, timeoutMs = 1_800_000, requestTimeoutMs = WORKSPACE_LIMITS.defaultTimeoutMs, onProgress} = options;
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0') || typeof resume !== 'boolean' || signal !== undefined && !(signal instanceof AbortSignal) || onProgress !== undefined && typeof onProgress !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000 || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > WORKSPACE_LIMITS.maxTimeoutMs) throw workspaceFailure('invalid_request', 'Invalid download options');
  if (!client || typeof client.getBinaryArtifactCapabilities !== 'function' || typeof client.getJobBinaryArtifact !== 'function' || typeof client.readJobBinaryArtifactChunk !== 'function') throw workspaceFailure('invalid_request', 'A connected workspace client is required');
  const binding = client.binding, controller = new AbortController();
  const onAbort = () => controller.abort(workspaceFailure('cancelled', 'Download cancelled'));
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, {once: true});
  const timer = setTimeout(() => controller.abort(workspaceFailure('budget_exceeded', 'Download deadline exceeded')), timeoutMs);
  const current = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!binding || client.binding !== binding) throw workspaceFailure('disposed', 'Download connection changed');
    if (reference.scope.projectId !== binding.workspace.id || reference.scope.sessionId !== binding.workspace.generation) throw workspaceFailure('generation_mismatch', 'Artifact belongs to another workspace generation');
  };
  const requestOptions = {signal: controller.signal, timeoutMs: requestTimeoutMs};
  let handle, key;
  try {
    current();
    const capabilities = await client.getBinaryArtifactCapabilities(requestOptions); current();
    if (!capabilities.enabled) throw workspaceFailure('unsupported', 'This host has not enabled binary artifacts');
    const chunkBytes = capabilities.limits.chunkBytes;
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > BINARY_ARTIFACT_LIMITS.chunkBytes) throw workspaceFailure('invalid_request', 'Invalid host chunk budget');
    const fresh = await client.getJobBinaryArtifact(reference.jobId, reference.artifact.id, requestOptions); current();
    if (fresh.jobId !== reference.jobId || fresh.scope.projectId !== reference.scope.projectId || fresh.scope.sessionId !== reference.scope.sessionId || !sameArtifact(fresh.artifact, reference.artifact)) throw workspaceFailure('conflict', 'Artifact reference changed');
    const suppliedParent = path.dirname(path.resolve(destination)), supplied = await fs.lstat(suppliedParent, {bigint: true});
    if (!supplied.isDirectory() || supplied.isSymbolicLink()) throw workspaceFailure('unsafe_path', 'Download parent must be a real directory');
    const parent = await fs.realpath(suppliedParent), initialParent = await fs.lstat(parent, {bigint: true});
    const target = path.join(parent, path.basename(destination)), partial = `${target}.dds-part`;
    key = process.platform === 'win32' ? partial.toLowerCase() : partial;
    if (active.has(key)) {key = undefined; throw workspaceFailure('conflict', 'This download destination is already in use');}
    if (active.size >= BINARY_ARTIFACT_LIMITS.concurrent) {key = undefined; throw workspaceFailure('budget_exceeded', 'Download capacity exceeded');}
    active.add(key);
    const verifyParent = async () => {
      const now = await fs.lstat(parent, {bigint: true});
      if (now.isSymbolicLink() || !now.isDirectory() || !sameIdentity(now, initialParent) || await fs.realpath(parent) !== parent) throw workspaceFailure('unsafe_path', 'Download parent changed');
      current();
    };
    await verifyParent();
    if (await optionalStat(target)) throw workspaceFailure('conflict', 'Download destination already exists');
    const previous = await optionalStat(partial);
    if (previous) {
      if (!resume) throw workspaceFailure('conflict', 'Partial download exists; explicitly resume it or choose another destination');
      regular(previous);
      if (previous.size > BigInt(reference.artifact.byteLength)) throw workspaceFailure('conflict', 'Partial download exceeds artifact size');
    }
    handle = await fs.open(partial, flags.O_RDWR | (flags.O_NOFOLLOW ?? 0) | (previous ? 0 : flags.O_CREAT | flags.O_EXCL), 0o600);
    let state = await handle.stat({bigint: true}); regular(state);
    if (previous && !sameState(previous, state)) throw workspaceFailure('conflict', 'Partial download changed');
    const verifyPartial = async expected => {
      await verifyParent(); const now = await handle.stat({bigint: true}), atPath = await fs.lstat(partial, {bigint: true});
      regular(now); regular(atPath);
      if (!sameState(now, expected) || !sameState(atPath, expected)) throw workspaceFailure('conflict', 'Partial download changed');
    };
    await verifyPartial(state);
    const resumedBytes = Number(state.size), hash = createHash('sha256'), buffer = Buffer.alloc(BINARY_ARTIFACT_LIMITS.chunkBytes);
    // Rehash existing bytes; no serialized hash state or unverified prefix is trusted.
    let prefix = 0;
    while (prefix < resumedBytes) {
      current(); const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, resumedBytes - prefix), prefix);
      if (!bytesRead) throw workspaceFailure('conflict', 'Partial download changed'); hash.update(buffer.subarray(0, bytesRead)); prefix += bytesRead;
    }
    await verifyPartial(state);
    let offset = resumedBytes;
    for (;;) {
      current();
      const response = parseBinaryArtifactChunk(await client.readJobBinaryArtifactChunk(reference, offset, {...requestOptions, length: chunkBytes})); current();
      if (response.jobId !== reference.jobId || response.scope.projectId !== reference.scope.projectId || response.scope.sessionId !== reference.scope.sessionId || !sameArtifact(response.artifact, reference.artifact) || response.offset !== offset || response.nextOffset !== offset + Math.min(chunkBytes, reference.artifact.byteLength - offset)) throw workspaceFailure('invalid_request', 'Download chunk identity mismatch');
      const bytes = decodeBinaryArtifactData(response.data);
      if (createHash('sha256').update(bytes).digest('hex') !== response.sha256) throw workspaceFailure('invalid_request', 'Download chunk checksum mismatch');
      await verifyPartial(state);
      let written = 0;
      while (written < bytes.length) {
        current(); const {bytesWritten} = await handle.write(bytes, written, bytes.length - written, offset + written);
        if (!bytesWritten) throw workspaceFailure('unavailable', 'Could not write download chunk'); written += bytesWritten;
      }
      state = await handle.stat({bigint: true});
      if (state.size !== BigInt(response.nextOffset)) throw workspaceFailure('conflict', 'Partial download changed');
      await verifyPartial(state); hash.update(bytes); offset = response.nextOffset;
      if (onProgress) {
        const result = onProgress(Object.freeze({receivedBytes: offset, totalBytes: reference.artifact.byteLength, resumedBytes, verified: false}));
        if (result && typeof result.then === 'function') {Promise.resolve(result).catch(() => {}); throw workspaceFailure('invalid_request', 'onProgress must be synchronous');}
      }
      current(); if (response.eof) break;
    }
    if (offset !== reference.artifact.byteLength || hash.digest('hex') !== reference.artifact.revision) throw workspaceFailure('conflict', 'Whole-file SHA-256 mismatch; partial download was not published');
    await verifyPartial(state); await handle.sync(); await verifyPartial(state);
    // Verify the actual staging file too, not only bytes accepted from transport.
    const stagedHash = createHash('sha256'); let checkedBytes = 0;
    while (checkedBytes < offset) {
      current(); const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, offset - checkedBytes), checkedBytes);
      if (!bytesRead) throw workspaceFailure('conflict', 'Partial download changed during verification');
      stagedHash.update(buffer.subarray(0, bytesRead)); checkedBytes += bytesRead;
    }
    await verifyPartial(state);
    if (stagedHash.digest('hex') !== reference.artifact.revision) throw workspaceFailure('conflict', 'Staging file SHA-256 mismatch');
    await handle.close(); handle = undefined; await verifyParent();
    const finalPartial = await fs.lstat(partial, {bigint: true}); regular(finalPartial);
    if (!sameState(finalPartial, state)) throw workspaceFailure('conflict', 'Partial download changed before publication');
    // link() publishes without overwriting an existing destination on Windows or Linux.
    await fs.link(partial, target);
    const published = await fs.lstat(target, {bigint: true}), remaining = await fs.lstat(partial, {bigint: true});
    if (published.isSymbolicLink() || remaining.isSymbolicLink() || !sameIdentity(published, state) || !sameIdentity(remaining, state)) throw workspaceFailure('conflict', 'Download publication changed');
    await fs.unlink(partial);
    return Object.freeze({path: target, revision: reference.artifact.revision, byteLength: offset, resumedBytes, verified: true});
  } catch (error) {if (controller.signal.aborted) throw controller.signal.reason; throw localError(error);}
  finally {
    try {if (handle) {try {await handle.sync();} finally {await handle.close();}}}
    finally {if (key) active.delete(key); clearTimeout(timer); signal?.removeEventListener('abort', onAbort);}
  }
}
