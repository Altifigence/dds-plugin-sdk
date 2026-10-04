import {copyWorkspaceJson, exactObject, requireFileContent, requireWorkspacePath, WORKSPACE_LIMITS, workspaceFailure} from './workspace-protocol.mjs';
import {watchWorkspaceFiles} from './workspace-observation.mjs';

import {applyTextEdits} from './text-edits.mjs';
export {applyTextEdits} from './text-edits.mjs';

/** Bind project operations to one explicit client connection; reconnection requires a new project. */
export function createWorkspaceProject(client) {
  if (!client || typeof client.readFile !== 'function' || typeof client.writeFile !== 'function' || typeof client.listFiles !== 'function') throw workspaceFailure('invalid_request', 'Expected a workspace client');
  const binding = client.binding;
  if (!binding) throw workspaceFailure('unavailable', 'Connect before creating a workspace project');
  const controller = new AbortController();
  const sessions = new Set();
  let reservations = 0;
  const current = () => !controller.signal.aborted && client.binding === binding;
  const closed = () => workspaceFailure('disposed', 'Workspace project connection changed or was disposed');
  function assertCurrent() { if (!current()) throw closed(); }
  function checkReply(requestOptions) {
    assertCurrent();
    if (requestOptions.signal.aborted) throw workspaceFailure('cancelled', 'Workspace operation cancelled');
  }
  function assertWritable() { assertCurrent(); if (!binding.capabilities.write) throw workspaceFailure('permission_denied', 'Workspace is read-only'); }
  function options(value = {}, sessionSignal) {
    exactObject(value, [], ['signal', 'timeoutMs']);
    if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw workspaceFailure('invalid_request', 'Expected AbortSignal');
    if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > WORKSPACE_LIMITS.maxTimeoutMs)) throw workspaceFailure('invalid_request', 'Invalid request timeout');
    assertCurrent();
    if (value.signal?.aborted) throw workspaceFailure('cancelled', 'Workspace operation cancelled');
    return {signal: AbortSignal.any([controller.signal, ...(sessionSignal ? [sessionSignal] : []), ...(value.signal ? [value.signal] : [])]), ...(value.timeoutMs === undefined ? {} : {timeoutMs: value.timeoutMs})};
  }
  function capacity() { if (sessions.size + reservations >= WORKSPACE_LIMITS.pending) throw workspaceFailure('budget_exceeded', 'Open edit session limit exceeded'); }
  function reserve() {
    capacity(); reservations++; let released = false;
    return () => { if (!released) { released = true; reservations--; } };
  }
  function editSession(file) {
    assertCurrent(); capacity();
    let snapshot = Object.freeze({...file}), phase = 'ready';
    const own = new AbortController();
    const active = () => current() && !own.signal.aborted;
    function assertIdle() {
      assertCurrent();
      if (own.signal.aborted) throw closed();
      if (phase === 'saving' || phase === 'reloading') throw workspaceFailure('conflict', 'Another edit operation is pending');
    }
    async function save(content, value) {
      assertIdle(); assertWritable();
      if (phase === 'needs-reload') throw workspaceFailure('conflict', 'Reload before saving after a failed or uncertain write');
      content = requireFileContent(content);
      const requestOptions = options(value, own.signal);
      phase = 'saving';
      try {
        const result = await client.writeFile(snapshot.path, content, snapshot.revision, requestOptions);
        if (!active()) throw closed();
        checkReply(requestOptions);
        snapshot = Object.freeze({path: snapshot.path, content, revision: result.revision});
        phase = 'ready'; return snapshot;
      } catch (failure) {
        // Cancellation or a lost reply does not prove that the server rolled back.
        phase = 'needs-reload'; throw failure;
      }
    }
    const session = Object.freeze({
      get snapshot() { assertCurrent(); if (own.signal.aborted) throw closed(); return snapshot; },
      get state() { return active() ? phase : 'disposed'; },
      save,
      async saveEdits(edits, value) { assertIdle(); return save(applyTextEdits(snapshot.content, edits), value); },
      async reload(value) {
        assertIdle(); const requestOptions = options(value, own.signal), previous = phase; phase = 'reloading';
        try {
          const result = await client.readFile(snapshot.path, requestOptions);
          if (!active()) throw closed();
          checkReply(requestOptions);
          snapshot = Object.freeze({...result}); phase = 'ready'; return snapshot;
        } catch (failure) { phase = previous; throw failure; }
      },
      dispose() { if (own.signal.aborted) return; own.abort(closed()); sessions.delete(session); },
    });
    sessions.add(session); return session;
  }
  return Object.freeze({
    get workspace() { assertCurrent(); return binding.workspace; },
    async getProjectCapabilities(value){const requestOptions=options(value),result=await client.getProjectCapabilities(requestOptions);checkReply(requestOptions);return result;},
    async getProjectSnapshot(input,value){const requestOptions=options(value),result=await client.getProjectSnapshot(input,requestOptions);checkReply(requestOptions);return result;},
    async listTree(input,value){const requestOptions=options(value),result=await client.listTree(input,requestOptions);checkReply(requestOptions);return result;},
    async searchFiles(input,value){const requestOptions=options(value),result=await client.searchFiles(input,requestOptions);checkReply(requestOptions);return result;},
    async searchText(input,value){const requestOptions=options(value),result=await client.searchText(input,requestOptions);checkReply(requestOptions);return result;},
    async releaseProjectQuery(cursor,value){const requestOptions=options(value),result=await client.releaseProjectQuery(cursor,requestOptions);checkReply(requestOptions);return result;},
    watchProject(input,value={}){assertCurrent();exactObject(value,[],['signal','requestTimeoutMs','timeoutMs']);if(value.signal!==undefined&&!(value.signal instanceof AbortSignal))throw workspaceFailure('invalid_request','Expected AbortSignal');return client.watchProject(input,{...value,signal:AbortSignal.any([controller.signal,...(value.signal?[value.signal]:[])])});},
    watchFiles(paths, value) {assertCurrent(); return watchWorkspaceFiles(client, paths, value, controller.signal);},
    async listFiles(path = '', value) {
      requireWorkspacePath(path, true);
      const requestOptions = options(value);
      const result = await client.listFiles(path, requestOptions); checkReply(requestOptions); return result;
    },
    async openFile(path, value) {
      requireWorkspacePath(path); assertCurrent();
      const requestOptions = options(value), release = reserve();
      try {
        const result = await client.readFile(path, requestOptions); checkReply(requestOptions); release(); return editSession(result);
      } finally { release(); }
    },
    async createFile(path, content, value) {
      requireWorkspacePath(path); content = requireFileContent(content); assertWritable();
      const requestOptions = options(value), release = reserve();
      try {
        const result = await client.writeFile(path, content, null, requestOptions); checkReply(requestOptions); release();
        return editSession({path, content, revision: result.revision});
      } finally { release(); }
    },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort(closed());
      for (const session of sessions) session.dispose();
      sessions.clear();
    },
  });
}
