import {WORKSPACE_PATH, WORKSPACE_LIMITS, WorkspaceError, workspaceFailure, exactObject, requireText, requireToken, requireWorkspacePath, requireSha256, parseWorkspaceRequest, parseWorkspaceReply, parseWorkspaceHello, parseWorkspaceMethodResult} from './workspace-protocol.mjs';
import {parseJobId, parseJobOptions} from './jobs.mjs';
import {BINARY_ARTIFACT_LIMITS, parseBinaryArtifactReference, parseBinaryArtifactRange, decodeBinaryArtifactData} from './artifacts.mjs';
import {registerObservationClient, watchWorkspaceJob, waitForWorkspaceJob} from './workspace-observation.mjs';
export {createWorkspaceProject, applyTextEdits} from './workspace-project.mjs';
export {WORKSPACE_OBSERVATION_LIMITS} from './workspace-observation.mjs';

export function normalizeWorkspaceUrl(value) {
  if(typeof value!=='string'||value.length>2_048||/[\s\u0000-\u001f\u007f\\]/u.test(value))throw workspaceFailure('invalid_request','Invalid workspace server URL');
  const raw=value.match(/^(https?):\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/i);
  if(!raw||![undefined,'/',WORKSPACE_PATH].includes(raw[3]))throw workspaceFailure('invalid_request','Invalid workspace server URL');
  let url;
  try { url = new URL(value); } catch { throw workspaceFailure('invalid_request', 'Invalid workspace server URL'); }
  const rawLoopback=/^(?:localhost|\[::1\]|127(?:\.(?:0|[1-9]\d{0,2})){3})(?::\d{1,5})?$/i.test(raw[2]);
  const loopback = rawLoopback&&(url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(url.hostname) && url.hostname.split('.').every(part => Number(part) <= 255));
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback) || !['/', WORKSPACE_PATH].includes(url.pathname)) {
    throw workspaceFailure('invalid_request', 'Workspace URL requires HTTPS or loopback HTTP and the workspace API path');
  }
  url.pathname = WORKSPACE_PATH;
  return url.href;
}

async function readResponse(response, signal) {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw workspaceFailure('transport_failed', 'Workspace server returned an invalid response');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > WORKSPACE_LIMITS.wireBytes)) throw workspaceFailure('budget_exceeded', 'Workspace response limit exceeded');
  if (!response.body) throw workspaceFailure('transport_failed', 'Workspace response is empty');
  const reader = response.body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, {once: true});
  const decoder = new TextDecoder('utf-8', {fatal: true});
  let total = 0, text = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > WORKSPACE_LIMITS.wireBytes) throw workspaceFailure('budget_exceeded', 'Workspace response limit exceeded');
      text += decoder.decode(value, {stream: true});
    }
    return text + decoder.decode();
  } catch (failure) { await reader.cancel().catch(() => {}); throw failure; }
  finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
}

/** Explicitly configured user-host client. It never downloads or runs plugin code. */
export function createWorkspaceClient({url, token, fetch: transport = globalThis.fetch, timeoutMs = WORKSPACE_LIMITS.defaultTimeoutMs} = {}) {
  const endpoint = normalizeWorkspaceUrl(url);
  token = requireToken(token);
  if (typeof transport !== 'function') throw workspaceFailure('invalid_request', 'A fetch transport is required');
  let binding, fileCapabilities, binaryCapabilities, closed = false, sequence = 0, bindingSequence = 0;
  let connectionController = new AbortController();
  const pending = new Set();
  const instance = globalThis.crypto.randomUUID();
  const budget = value => {
    if (!Number.isInteger(value) || value < 1 || value > WORKSPACE_LIMITS.maxTimeoutMs) throw workspaceFailure('invalid_request', 'Invalid request timeout');
    return value;
  };
  budget(timeoutMs);
  const revoke = (reason = workspaceFailure('disposed', 'Workspace connection changed')) => {
    binding = undefined; fileCapabilities = undefined; binaryCapabilities = undefined; bindingSequence++;
    connectionController.abort(reason);
    connectionController = new AbortController();
    for (const controller of pending) controller.abort(workspaceFailure('disposed', 'Workspace connection changed'));
  };
  async function send(envelope, signal) {
    const request = parseWorkspaceRequest(envelope);
    const response = await transport(endpoint, {method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`}, body: JSON.stringify(request), signal});
    try {
      signal.throwIfAborted();
      if (response.redirected || response.status >= 300 && response.status < 400) throw workspaceFailure('transport_failed', 'Workspace redirects are forbidden');
      if (response.status === 401 || response.status === 403) throw workspaceFailure('authentication_required', 'Workspace server rejected authentication or origin');
      if (!response.ok) throw workspaceFailure('transport_failed', 'Workspace server rejected the request');
      const reply = parseWorkspaceReply(await readResponse(response, signal), request.requestId);
      if (!reply.ok) throw workspaceFailure(reply.error.code, `Workspace request failed (${reply.error.code})`);
      return parseWorkspaceMethodResult(request.method, reply.result);
    } finally {
      // Rejected status/headers must not leave an unread network body alive.
      if (response.body) await response.body.cancel().catch(() => {});
    }
  }
  async function cancelRemote(requestId, captured) {
    if (!captured || closed) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_000);
    try { await send({version: 1, requestId: `${instance}-${++sequence}`, method: 'request.cancel', workspaceId: captured.workspace.id, generation: captured.workspace.generation, params: {requestId}}, controller.signal); }
    catch { /* best effort only: timeout/disconnect do not prove rollback */ }
    finally { clearTimeout(timer); }
  }
  async function request(method, params, {signal, timeoutMs: requestTimeout = timeoutMs} = {}) {
    if (closed) throw workspaceFailure('disposed', 'Workspace client is disposed');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw workspaceFailure('invalid_request', 'Expected AbortSignal');
    if (signal?.aborted) throw workspaceFailure('cancelled', 'Workspace request cancelled');
    budget(requestTimeout);
    const captured = binding, revision = bindingSequence;
    if (method !== 'hello' && !captured) throw workspaceFailure('unavailable', 'Connect to a workspace first');
    if (pending.size >= WORKSPACE_LIMITS.pending) throw workspaceFailure('budget_exceeded', 'Pending request limit exceeded');
    const requestId = `${instance}-${++sequence}`;
    const envelope = {version: 1, requestId, method, params, ...(method === 'hello' ? {} : {workspaceId: captured.workspace.id, generation: captured.workspace.generation})};
    // Validate before acquiring a pending slot or sending anything.
    parseWorkspaceRequest(envelope);
    const controller = new AbortController(); pending.add(controller);
    const onAbort = () => controller.abort(workspaceFailure('cancelled', 'Workspace request cancelled'));
    signal?.addEventListener('abort', onAbort, {once: true});
    const timer = setTimeout(() => controller.abort(workspaceFailure('budget_exceeded', 'Workspace request timed out')), requestTimeout);
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', rejectAbort, {once: true}); });
    try {
      const result = await Promise.race([send(envelope, controller.signal), aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (closed || revision !== bindingSequence) throw workspaceFailure('disposed', 'Workspace connection changed');
      if (method.startsWith('fs.') && result.path !== undefined && result.path !== params.path) throw workspaceFailure('invalid_request', 'Workspace reply path mismatch');
      if (method === 'fs.readIfChanged' && result.notModified !== (params.knownRevision !== null && result.revision === params.knownRevision)) throw workspaceFailure('invalid_request', 'Conditional file revision mismatch');
      if (method === 'fs.rename' && result.newPath !== params.newPath) throw workspaceFailure('invalid_request', 'Workspace reply path mismatch');
      if (method === 'fs.list' && result.entries.some(entry => entry.path.slice(0, entry.path.lastIndexOf('/') + 1) !== (params.path ? `${params.path}/` : ''))) throw workspaceFailure('invalid_request', 'Workspace listing scope mismatch');
      if (method === 'plugins.list' && JSON.stringify(result.plugins) !== JSON.stringify(captured.plugins)) {
        const error = workspaceFailure('plugin_mismatch', 'Workspace plugin metadata changed; reconnect and obtain consent again');
        revoke(error); throw error;
      }
      if (method.startsWith('artifacts.') && method !== 'artifacts.capabilities') {
        if (result.jobId !== params.jobId || result.scope.projectId !== captured.workspace.id || result.scope.sessionId !== captured.workspace.generation) throw workspaceFailure('invalid_request', 'Artifact reply identity mismatch');
        if (method === 'artifacts.read') {
          if (result.artifact.id !== params.artifactId || result.artifact.revision !== params.revision || result.offset !== params.offset || result.nextOffset !== params.offset + Math.min(params.length, result.artifact.byteLength - params.offset)) throw workspaceFailure('invalid_request', 'Artifact range or revision mismatch');
          const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', decodeBinaryArtifactData(result.data)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (controller.signal.aborted) throw controller.signal.reason;
          if (closed || revision !== bindingSequence) throw workspaceFailure('disposed', 'Workspace connection changed');
          if (digest !== result.sha256) throw workspaceFailure('invalid_request', 'Artifact chunk digest mismatch');
        }
      }
      if (method.startsWith('jobs.') && method !== 'jobs.capabilities') {
        if (result.jobId !== params.jobId || result.scope.projectId !== captured.workspace.id || result.scope.sessionId !== captured.workspace.generation) throw workspaceFailure('invalid_request', 'Job reply identity mismatch');
        if (method === 'jobs.start' && (result.pluginId !== params.pluginId || result.commandId !== params.commandId)) throw workspaceFailure('invalid_request', 'Job command identity mismatch');
        if (method === 'jobs.events' && result.after !== params.after) throw workspaceFailure('invalid_request', 'Job event cursor mismatch');
        if (method === 'jobs.artifact') {
          if (result.artifact.id !== params.artifactId) throw workspaceFailure('invalid_request', 'Job artifact identity mismatch');
          const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.content)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (controller.signal.aborted) throw controller.signal.reason;
          if (closed || revision !== bindingSequence) throw workspaceFailure('disposed', 'Workspace connection changed');
          if (digest !== result.artifact.revision) throw workspaceFailure('invalid_request', 'Job artifact digest mismatch');
        }
      }
      return result;
    } catch (failure) {
      if (controller.signal.aborted) { if (method !== 'hello' && method !== 'request.cancel') void cancelRemote(requestId, captured); throw controller.signal.reason; }
      if (failure instanceof WorkspaceError) {
        if (['workspace_mismatch', 'generation_mismatch', 'authentication_required', 'plugin_mismatch'].includes(failure.code)) revoke(failure);
        throw failure;
      }
      throw workspaceFailure('transport_failed', 'Workspace transport failed');
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort); controller.signal.removeEventListener('abort', rejectAbort); pending.delete(controller);
    }
  }
  function checkFileConnection(captured, {signal, timeoutMs: requestTimeout = timeoutMs} = {}) {
    if (closed || captured !== binding) throw workspaceFailure('disposed', 'Workspace connection changed');
    if (!captured) throw workspaceFailure('unavailable', 'Connect to a workspace first');
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw workspaceFailure('invalid_request', 'Expected AbortSignal');
    if (signal?.aborted) throw workspaceFailure('cancelled', 'Workspace request cancelled');
    budget(requestTimeout);
  }
  async function getFileCapabilities(options) {
    const captured = binding; checkFileConnection(captured, options);
    if (fileCapabilities) return fileCapabilities;
    const legacy = Object.freeze({protocolVersion: 1, revision: false, conditionalRead: false});
    // Released pre-0.6 SDK hosts reject unknown methods before retaining their
    // request ID. Recognize those versions without weakening reply validation.
    if (captured.hostId === 'workspace-host' && /^0\.[0-5]\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(captured.hostVersion)) return fileCapabilities = legacy;
    let capabilities;
    try {capabilities = await request('fs.capabilities', {}, options);}
    catch (error) {
      if (!(error instanceof WorkspaceError) || error.code !== 'unsupported') throw error;
      capabilities = legacy;
    }
    checkFileConnection(captured, options);
    return fileCapabilities = capabilities;
  }
  async function getFileRevision(path, options) {
    requireWorkspacePath(path);
    const captured = binding, capabilities = await getFileCapabilities(options);
    checkFileConnection(captured, options);
    const file = await request(capabilities.revision ? 'fs.revision' : 'fs.read', {path}, options);
    return Object.freeze({path: file.path, revision: file.revision});
  }
  async function readFileIfChanged(path, knownRevision, options) {
    requireWorkspacePath(path); if (knownRevision !== null) requireSha256(knownRevision);
    const captured = binding, capabilities = await getFileCapabilities(options);
    checkFileConnection(captured, options);
    if (capabilities.conditionalRead) return request('fs.readIfChanged', {path, knownRevision}, options);
    const file = await request('fs.read', {path}, options);
    return Object.freeze(file.revision === knownRevision ? {path: file.path, revision: file.revision, notModified: true} : {...file, notModified: false});
  }
  async function getBinaryArtifactCapabilities(options) {
    const captured = binding; checkFileConnection(captured, options);
    if (binaryCapabilities) return binaryCapabilities;
    const unavailable = Object.freeze({protocolVersion: 1, enabled: false, limits: BINARY_ARTIFACT_LIMITS});
    if (captured.hostId === 'workspace-host' && /^0\.[0-6]\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(captured.hostVersion)) return binaryCapabilities = unavailable;
    let result;
    try {result = await request('artifacts.capabilities', {}, options);}
    catch (error) {if (!(error instanceof WorkspaceError) || error.code !== 'unsupported') throw error; result = unavailable;}
    checkFileConnection(captured, options); return binaryCapabilities = result;
  }
  async function requireBinaryConnection(captured, options) {
    const capabilities = await getBinaryArtifactCapabilities(options); checkFileConnection(captured, options);
    if (!capabilities.enabled) throw workspaceFailure('unsupported', 'This host has not enabled binary artifacts'); return capabilities;
  }
  async function listJobBinaryArtifacts(jobId, options) {
    parseJobId(jobId); const captured = binding; await requireBinaryConnection(captured, options);
    return request('artifacts.list', {jobId}, options);
  }
  async function getJobBinaryArtifact(jobId, artifactId, options) {
    requireText(artifactId); const result = await listJobBinaryArtifacts(jobId, options);
    const artifact = result.artifacts.find(artifact => artifact.id === artifactId);
    if (!artifact) throw workspaceFailure('not_found', 'Binary artifact is not registered');
    return Object.freeze({jobId: result.jobId, scope: result.scope, artifact});
  }
  async function readJobBinaryArtifactChunk(reference, offset, options = {}) {
    reference = parseBinaryArtifactReference(reference); exactObject(options, [], ['length', 'signal', 'timeoutMs']);
    const {length: requestedLength, ...requestOptions} = options;
    parseBinaryArtifactRange(offset, requestedLength ?? BINARY_ARTIFACT_LIMITS.chunkBytes, reference.artifact.byteLength);
    const captured = binding; checkFileConnection(captured, requestOptions);
    if (reference.scope.projectId !== captured.workspace.id || reference.scope.sessionId !== captured.workspace.generation) throw workspaceFailure('generation_mismatch', 'Artifact belongs to another workspace generation');
    const capabilities = await requireBinaryConnection(captured, requestOptions);
    const length = requestedLength ?? capabilities.limits.chunkBytes;
    if (length > capabilities.limits.chunkBytes || reference.artifact.byteLength > capabilities.limits.fileBytes) throw workspaceFailure('budget_exceeded', 'Artifact exceeds the host transfer budget');
    const result = await request('artifacts.read', {jobId: reference.jobId, artifactId: reference.artifact.id, revision: reference.artifact.revision, offset, length}, requestOptions);
    if (['id', 'path', 'revision', 'byteLength', 'label'].some(key => result.artifact[key] !== reference.artifact[key])) throw workspaceFailure('invalid_request', 'Artifact metadata changed');
    return result;
  }
  const client = Object.freeze({
    async connect(options) {
      revoke();
      const connectSequence = bindingSequence;
      const result = parseWorkspaceHello(await request('hello', {}, options));
      if (closed) throw workspaceFailure('disposed', 'Workspace client is disposed');
      // Notice hashing is verified without trusting the advertised digest.
      const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.notice.text)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (closed || connectSequence !== bindingSequence) throw workspaceFailure('disposed', 'Workspace connection changed');
      if (digest !== result.notice.sha256) throw workspaceFailure('invalid_request', 'Workspace notice digest mismatch');
      binding = result;
      return result;
    },
    get binding() { return binding; },
    request,
    listFiles: (path = '', options) => request('fs.list', {path}, options),
    readFile: (path, options) => request('fs.read', {path}, options),
    getFileCapabilities,
    getFileRevision,
    readFileIfChanged,
    writeFile: (path, content, expectedRevision, options) => request('fs.write', {path, content, expectedRevision}, options),
    mkdir: (path, options) => request('fs.mkdir', {path}, options),
    rename: (path, newPath, expectedRevision, options) => request('fs.rename', {path, newPath, ...(expectedRevision === undefined ? {} : {expectedRevision})}, options),
    remove: (path, expectedRevision, options) => request('fs.remove', {path, ...(expectedRevision === undefined ? {} : {expectedRevision})}, options),
    listPlugins: options => request('plugins.list', {}, options),
    runCommand: (pluginId, commandId, input, artifactSha256, options) => request('commands.run', {pluginId, commandId, input, artifactSha256}, options),
    getJobCapabilities: options => request('jobs.capabilities', {}, options),
    startCommandJob: async (pluginId, commandId, input, artifactSha256, job, options) => request('jobs.start', {pluginId, commandId, input, artifactSha256, ...parseJobOptions(job)}, options),
    getJob: (jobId, options) => request('jobs.get', {jobId}, options),
    getJobEvents: (jobId, after = 0, options) => request('jobs.events', {jobId, after}, options),
    cancelJob: (jobId, options) => request('jobs.cancel', {jobId}, options),
    readJobArtifact: (jobId, artifactId, options) => request('jobs.artifact', {jobId, artifactId}, options),
    getBinaryArtifactCapabilities,
    listJobBinaryArtifacts,
    getJobBinaryArtifact,
    readJobBinaryArtifactChunk,
    watchJob: (jobId, options) => watchWorkspaceJob(client, jobId, options),
    waitForJob: (jobId, options) => waitForWorkspaceJob(client, jobId, options),
    disconnect() { revoke(); },
    dispose() { if (closed) return; revoke(); closed = true; token = ''; },
  });
  registerObservationClient(client, () => connectionController.signal);
  return client;
}
