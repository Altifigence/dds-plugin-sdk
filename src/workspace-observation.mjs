import {copyWorkspaceJson, exactObject, requireWorkspacePath, WORKSPACE_LIMITS, WorkspaceError, workspaceFailure} from './workspace-protocol.mjs';
import {parseJobId} from './jobs.mjs';

export const WORKSPACE_OBSERVATION_LIMITS = Object.freeze({observers: 8, files: 16, minIntervalMs: 250, maxIntervalMs: 60_000, defaultIntervalMs: 1_000, maxTimeoutMs: 1_800_000});
const clients = new WeakMap();
const invalid = message => workspaceFailure('invalid_request', message);
const disposed = () => workspaceFailure('disposed', 'Workspace observation connection changed or was disposed');
function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

// A connection's signal stays private. Observers cannot reconnect or alter grants.
export function registerObservationClient(client, signal) { clients.set(client, {signal, active: new Set()}); }

function observationOptions(value, extras = [], defaultTimeoutMs) {
  exactObject(value, [], ['signal', 'intervalMs', 'requestTimeoutMs', 'timeoutMs', ...extras]);
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw invalid('Expected AbortSignal');
  const intervalMs = value.intervalMs ?? WORKSPACE_OBSERVATION_LIMITS.defaultIntervalMs;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < WORKSPACE_OBSERVATION_LIMITS.minIntervalMs || intervalMs > WORKSPACE_OBSERVATION_LIMITS.maxIntervalMs) throw invalid('Invalid observation interval');
  for (const [key, maximum] of [['requestTimeoutMs', WORKSPACE_LIMITS.maxTimeoutMs], ['timeoutMs', WORKSPACE_OBSERVATION_LIMITS.maxTimeoutMs]]) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > maximum)) throw invalid(`Invalid ${key}`);
  }
  return {...value, intervalMs, timeoutMs: value.timeoutMs ?? defaultTimeoutMs};
}

/** Pull-driven iterator: one pending next, no background fetch or event queue. */
function observer(client, options, step, parentSignal) {
  const owner = clients.get(client), binding = client?.binding;
  if (!owner) throw invalid('Use a client created by createWorkspaceClient');
  if (!binding) throw workspaceFailure('unavailable', 'Connect before observing a workspace');
  const controller = new AbortController();
  const listeners = [];
  let started = false, ended = false, busy = false, graceful = false, failure, failureDelivered = false, deadline;
  function stop(reason) {
    if (ended) return;
    ended = true; failure = reason;
    clearTimeout(deadline);
    for (const [signal, callback] of listeners) signal.removeEventListener('abort', callback);
    listeners.length = 0; owner.active.delete(controller);
    controller.abort(reason ?? disposed());
  }
  function check() {
    if (ended) throw failure ?? disposed();
    if (client.binding !== binding) throw disposed();
    if (controller.signal.aborted) throw controller.signal.reason;
  }
  function listen(signal, reason) {
    if (!signal) return;
    if (signal.aborted) throw reason();
    const callback = () => stop(reason());
    signal.addEventListener('abort', callback, {once: true}); listeners.push([signal, callback]);
  }
  function start() {
    check();
    if (owner.active.size >= WORKSPACE_OBSERVATION_LIMITS.observers) throw workspaceFailure('budget_exceeded', 'Workspace observer limit exceeded');
    started = true; owner.active.add(controller);
    const connectionSignal = owner.signal();
    listen(connectionSignal, () => connectionSignal.reason instanceof WorkspaceError ? connectionSignal.reason : disposed());
    listen(parentSignal, disposed);
    listen(options.signal, () => workspaceFailure('cancelled', 'Workspace observation cancelled'));
    if (options.timeoutMs !== undefined) deadline = setTimeout(() => stop(workspaceFailure('budget_exceeded', 'Workspace observation timed out')), options.timeoutMs);
  }
  const context = {
    check,
    requestOptions: {signal: controller.signal, ...(options.requestTimeoutMs === undefined ? {} : {timeoutMs: options.requestTimeoutMs})},
    async pause() {
      check();
      await new Promise((resolve, reject) => {
        const onAbort = () => {clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); reject(controller.signal.reason);};
        const timer = setTimeout(() => {controller.signal.removeEventListener('abort', onAbort); resolve();}, options.intervalMs);
        controller.signal.addEventListener('abort', onAbort, {once: true});
      });
      check();
    },
  };
  const iterator = {
    async next() {
      if (busy) throw workspaceFailure('conflict', 'An observation read is already pending');
      if (ended) {
        if (failure && !failureDelivered) {failureDelivered = true; throw failure;}
        return {done: true, value: undefined};
      }
      busy = true;
      try {
        if (!started) start();
        check();
        const result = await step(context);
        check();
        if (result.last) stop();
        return {done: false, value: result.value};
      } catch (error) {
        if (graceful) return {done: true, value: undefined};
        stop(error); failureDelivered = true; throw failure ?? error;
      } finally {busy = false;}
    },
    async return() {graceful = true; failureDelivered = true; stop(); return {done: true, value: undefined};},
    [Symbol.asyncIterator]() {return iterator;},
  };
  return Object.freeze(iterator);
}

export function watchWorkspaceFiles(client, paths, value = {}, parentSignal) {
  paths = copyWorkspaceJson(paths);
  if (!Array.isArray(paths) || !paths.length || paths.length > WORKSPACE_OBSERVATION_LIMITS.files) throw invalid('Expected 1 to 16 explicit file paths');
  for (const path of paths) requireWorkspacePath(path);
  if (new Set(paths).size !== paths.length) throw invalid('Duplicate observed path');
  const options = observationOptions(value, ['includeInitial']);
  if (options.includeInitial !== undefined && typeof options.includeInitial !== 'boolean') throw invalid('Invalid includeInitial option');
  if (client?.binding && !client.binding.capabilities.read) throw workspaceFailure('permission_denied', 'Workspace read access is required');
  const revisions = new Map(); let index = 0, completedPass = false;
  return observer(client, options, async context => {
    for (;;) {
      if (completedPass) {await context.pause(); completedPass = false;}
      context.check();
      const path = paths[index]; let revision;
      try {revision = (await client.readFile(path, context.requestOptions)).revision;}
      catch (error) {if (!(error instanceof WorkspaceError) || error.code !== 'not_found') throw error; revision = null;}
      context.check();
      const initial = !revisions.has(path), previousRevision = revisions.get(path) ?? null;
      revisions.set(path, revision);
      index = (index + 1) % paths.length; completedPass = index === 0;
      if (initial && options.includeInitial !== false || !initial && revision !== previousRevision) {
        const kind = initial ? 'initial' : revision === null ? 'deleted' : previousRevision === null ? 'created' : 'changed';
        return {value: Object.freeze({kind, path, previousRevision, revision})};
      }
    }
  }, parentSignal);
}

export function watchWorkspaceJob(client, jobId, value = {}) {
  try {parseJobId(jobId);} catch {throw invalid('Invalid job ID');}
  const options = observationOptions(value, ['after'], WORKSPACE_OBSERVATION_LIMITS.maxTimeoutMs);
  let cursor = options.after ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw invalid('Invalid job cursor');
  let previous, identity, pause = false;
  return observer(client, options, async context => {
    for (;;) {
      if (pause) await context.pause();
      context.check();
      const page = await client.getJobEvents(jobId, cursor, context.requestOptions); context.check();
      const snapshot = await client.getJob(jobId, context.requestOptions); context.check();
      const currentIdentity = JSON.stringify([snapshot.pluginId, snapshot.commandId, snapshot.startedAt, snapshot.timeoutMs]);
      const changedIdentity = identity !== undefined && identity !== currentIdentity;
      const invalidCursor = page.nextCursor > snapshot.lastSequence || page.hasMore && page.nextCursor === snapshot.lastSequence;
      const regressed = previous && (snapshot.lastSequence < previous.lastSequence || snapshot.updatedAt < previous.updatedAt || previous.state !== 'running' && snapshot.state !== previous.state);
      const unsequencedChange = previous && snapshot.lastSequence === previous.lastSequence && !sameJson(snapshot, previous);
      if (changedIdentity || invalidCursor || regressed || unsequencedChange) throw invalid('Job observation identity or sequence changed');
      identity = currentIdentity;
      const hasMore = page.hasMore || page.nextCursor < snapshot.lastSequence;
      const last = snapshot.state !== 'running' && !hasMore;
      const changed = !previous || previous.lastSequence !== snapshot.lastSequence || previous.state !== snapshot.state;
      previous = snapshot; cursor = page.nextCursor; pause = !hasMore;
      if (changed || page.events.length || page.dropped || last) {
        return {value: Object.freeze({snapshot, events: page.events, after: page.after, nextCursor: cursor, dropped: page.dropped, hasMore}), last};
      }
    }
  });
}

export async function waitForWorkspaceJob(client, jobId, options) {
  let snapshot;
  for await (const update of watchWorkspaceJob(client, jobId, options)) snapshot = update.snapshot;
  if (!snapshot || snapshot.state === 'running') throw workspaceFailure('unavailable', 'Job observation ended before completion');
  return snapshot;
}
