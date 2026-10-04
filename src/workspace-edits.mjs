import {exactObject, requireUuid, requireSha256, WORKSPACE_ERROR_CODES} from './workspace-values.mjs';
import {textIndex} from './language-values.mjs';
import {parseWorkspaceEdit, parseWorkspaceEditPreview, parseWorkspaceEditRecord, parseWorkspaceEditReceipt, buildEditPreview, changePaths, parseEditFileState, editCopy, canonicalEditJson, editFailure} from './workspace-edit-contracts.mjs';
export {WORKSPACE_EDIT_LIMITS, WORKSPACE_EDIT_CAPABILITIES, parseWorkspaceEdit, parseWorkspaceEditPreview, parseWorkspaceEditRecord, parseWorkspaceEditReceipt} from './workspace-edit-contracts.mjs';

const active = new WeakSet();
const activeJournals = new WeakSet();
const codeOf = error => WORKSPACE_ERROR_CODES.includes(error?.code) ? error.code : 'provider_failed';
function optionsCheck(options, fields = []) {
  exactObject(options, [], ['signal', 'timeoutMs', ...fields]);
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw editFailure('invalid_request');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000)) throw editFailure('invalid_request');
  return {signal: options.signal, timeoutMs: options.timeoutMs};
}
function check(client, expected, signal, allowNewGeneration = false) {
  if (signal?.aborted) throw editFailure('cancelled');
  const binding = client?.binding;
  if (!binding || typeof client.readFile !== 'function') throw editFailure('unavailable');
  const workspace = {id: binding.workspace.id, generation: binding.workspace.generation};
  requireUuid(workspace.id); requireUuid(workspace.generation);
  if (expected && workspace.id !== expected.id) throw editFailure('workspace_mismatch');
  if (expected && !allowNewGeneration && workspace.generation !== expected.generation) throw editFailure('generation_mismatch');
  return workspace;
}
async function readState(client, path, expected, options, allowNewGeneration = false) {
  check(client, expected, options.signal, allowNewGeneration);
  let state;
  try {
    const file = await client.readFile(path, options);
    exactObject(file, ['path', 'content', 'revision']);
    if (file.path !== path) throw editFailure('conflict');
    state = parseEditFileState({content: file.content, revision: file.revision});
  } catch (error) {if (error?.code !== 'not_found') throw error; state = null;}
  check(client, expected, options.signal, allowNewGeneration);
  return state;
}
export async function previewWorkspaceEdit(client, input, options = {}) {
  const request = optionsCheck(options), edit = parseWorkspaceEdit(input), workspace = check(client, undefined, request.signal), originals = [];
  for (const path of edit.changes.flatMap(changePaths)) originals.push({path, state: await readState(client, path, workspace, request)});
  return buildEditPreview(edit, workspace, originals);
}
async function authorize(client, preview, options, phase, index) {
  check(client, preview.workspace, options.signal);
  if (typeof options.authorize !== 'function') throw editFailure('permission_denied');
  const controller = new AbortController();
  const abort = () => controller.abort(editFailure('cancelled'));
  options.signal?.addEventListener('abort', abort, {once: true});
  let onAbort, approved;
  const stopped = new Promise((_, reject) => {onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, {once: true});});
  const timer = setTimeout(() => controller.abort(editFailure('budget_exceeded')), options.timeoutMs ?? 5000);
  try {
    approved = await Promise.race([Promise.resolve().then(() => options.authorize(editCopy({planId: preview.planId, digest: preview.digest, workspace: preview.workspace, requiredCapabilities: preview.requiredCapabilities, phase, index}), {signal: controller.signal})), stopped]);
  } finally {clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort);}
  check(client, preview.workspace, options.signal);
  if (approved !== true || preview.requiredCapabilities.some(capability => client.binding.capabilities[capability] !== true)) throw editFailure('permission_denied');
}
const equalState = (a, b) => a === null || b === null ? a === b : a.revision === b.revision;
async function preflight(client, preview, request) {
  for (const step of preview.steps) for (const original of step.before) if (!equalState(await readState(client, original.path, preview.workspace, request), original.state)) throw editFailure('conflict');
}
async function observeStep(client, preview, step, request, allowNewGeneration = false) {
  try {
    const states = [];
    for (const file of step.before) states.push(await readState(client, file.path, preview.workspace, request, allowNewGeneration));
    if (states.every((state, n) => equalState(state, step.after[n].state))) return {state: 'applied'};
    if (states.every((state, n) => equalState(state, step.before[n].state))) return {state: 'not-applied'};
    return {state: 'conflicted'};
  } catch (error) {return {state: 'unknown', errorCode: codeOf(error)};}
}
function receipt(preview, observations, details = {}) {
  const applied = observations.filter(step => step.state === 'applied').length;
  const uncertain = observations.some(step => ['unknown', 'conflicted', 'intent'].includes(step.state));
  return parseWorkspaceEditReceipt({formatVersion: 1, planId: preview.planId, digest: preview.digest, workspaceId: preview.workspace.id,
    status: uncertain ? 'uncertain' : applied === observations.length ? 'completed' : applied ? 'partial' : 'not-applied',
    steps: observations.map((step, index) => ({index, ...step, canCompensate: step.state === 'applied'})), ...details});
}
async function perform(client, change, step, request) {
  if (change.kind === 'edit') await client.writeFile(change.path, step.after[0].state.content, change.baseRevision, request);
  else if (change.kind === 'create') await client.writeFile(change.path, change.content, null, request);
  else if (change.kind === 'move') await client.rename(change.path, change.newPath, change.baseRevision, request);
  else await client.remove(change.path, change.baseRevision, request);
}
export async function applyWorkspaceEdit(client, input, options = {}) {
  const request = optionsCheck(options, ['reviewed', 'authorize', 'journal']), preview = parseWorkspaceEditPreview(input);
  exactObject(options.reviewed, ['planId', 'digest']); requireUuid(options.reviewed.planId); requireSha256(options.reviewed.digest);
  if (options.reviewed.planId !== preview.planId || options.reviewed.digest !== preview.digest || !preview.ready) throw editFailure('conflict');
  const journal = options.journal;
  if (!journal || typeof journal.begin !== 'function' || typeof journal.write !== 'function' || typeof journal.read !== 'function') throw editFailure('invalid_request');
  check(client, preview.workspace, request.signal);
  if (active.has(client) || activeJournals.has(journal)) throw editFailure('conflict'); active.add(client); activeJournals.add(journal);
  try {
    await authorize(client, preview, options, 'preflight', null); await preflight(client, preview, request);
    let record = parseWorkspaceEditRecord({formatVersion: 1, preview, revision: 1, phase: 'applying', steps: preview.steps.map(() => ({state: 'pending'})), updatedAt: Date.now()});
    const verifyJournal = async () => {
      const saved = parseWorkspaceEditRecord(await journal.read(preview.planId));
      if (canonicalEditJson(saved) !== canonicalEditJson(record)) throw editFailure('conflict');
    };
    await journal.begin(record); await verifyJournal();
    const observations = preview.steps.map(() => ({state: 'not-applied'}));
    async function checkpoint(index, state, phase = 'applying') {
      record = parseWorkspaceEditRecord({...record, revision: record.revision + 1, phase, updatedAt: Date.now(), steps: record.steps.map((step, n) => n === index ? state : step)});
      await journal.write(record); await verifyJournal();
    }
    for (let index = 0; index < preview.steps.length; index++) {
      const step = preview.steps[index], change = preview.edit.changes[index];
      let operationStarted = false;
      try {
        await authorize(client, preview, options, 'before-change', index);
        for (const original of step.before) if (!equalState(await readState(client, original.path, preview.workspace, request), original.state)) throw editFailure('conflict');
        await checkpoint(index, {state: 'intent'});
        await authorize(client, preview, options, 'apply', index);
        operationStarted = true;
        await perform(client, change, step, request);
        observations[index] = await observeStep(client, preview, step, request);
        if (observations[index].state !== 'applied') throw editFailure(observations[index].errorCode ?? 'conflict');
        await checkpoint(index, {state: 'applied'}, index === preview.steps.length - 1 ? 'completed' : 'applying');
      } catch (error) {
        if (operationStarted) {
          // Do not ignore cancellation or reconnect to manufacture a successful
          // readback. A caller can explicitly recover with fresh authority later.
          observations[index] = await observeStep(client, preview, step, request);
          if (observations[index].state === 'not-applied' && ['transport_failed', 'cancelled', 'budget_exceeded', 'unavailable'].includes(codeOf(error))) observations[index] = {state: 'unknown', errorCode: codeOf(error)};
        }
        let journalError;
        try {await checkpoint(index, {...observations[index], errorCode: codeOf(error)}, 'stopped');}
        catch (failure) {journalError = codeOf(failure);}
        return receipt(preview, observations, {executionStopped: true, errorCode: codeOf(error), ...(journalError ? {journalError} : {})});
      }
    }
    return receipt(preview, observations, {executionStopped: false});
  } finally {active.delete(client); activeJournals.delete(journal);}
}

/** Read current file states; never replay an old journal or change a file. */
export async function recoverWorkspaceEdit(client, journal, planId, options = {}) {
  const request = optionsCheck(options); requireUuid(planId);
  if (!journal || typeof journal.read !== 'function') throw editFailure('invalid_request');
  if (active.has(client) || activeJournals.has(journal)) throw editFailure('conflict');
  const record = parseWorkspaceEditRecord(await journal.read(planId));
  if (record.preview.planId !== planId) throw editFailure('conflict');
  const workspace = check(client, record.preview.workspace, request.signal, true), observations = [];
  for (const step of record.preview.steps) {
    const current = await observeStep(client, record.preview, step, request, true);
    // A durable applied receipt followed by original bytes is an external change,
    // not proof that the operation was never applied.
    if (record.steps[step.index].state === 'applied' && current.state === 'not-applied') current.state = 'conflicted';
    observations.push(current);
  }
  return receipt(record.preview, observations, {currentGeneration: workspace.generation, journalPhase: record.phase, journalRevision: record.revision});
}

/** Build a new proposal only. Its preview, current CAS and approval remain mandatory. */
export function createWorkspaceCompensation(input, recovery, {id, title = 'Restore reviewed workspace changes'} = {}) {
  const preview = parseWorkspaceEditPreview(input), value = parseWorkspaceEditReceipt(recovery); requireUuid(id); if (id === preview.planId) throw editFailure('conflict');
  if (value.planId !== preview.planId || value.digest !== preview.digest || value.workspaceId !== preview.workspace.id || !Array.isArray(value.steps) || value.steps.length !== preview.steps.length) throw editFailure('conflict');
  const changes = [];
  for (let n = preview.steps.length - 1; n >= 0; n--) {
    if (value.steps[n].index !== n) throw editFailure('conflict');
    if (value.steps[n].state !== 'applied') continue;
    const step = preview.steps[n], change = preview.edit.changes[n];
    if (change.kind === 'create') changes.push({kind: 'delete', path: change.path, baseRevision: step.after[0].state.revision});
    else if (change.kind === 'delete') changes.push({kind: 'create', path: change.path, content: step.before[0].state.content});
    else if (change.kind === 'move') changes.push({kind: 'move', path: change.newPath, newPath: change.path, baseRevision: step.after[1].state.revision});
    else {
      const content = step.after[0].state.content;
      changes.push({kind: 'edit', path: change.path, baseRevision: step.after[0].state.revision, edits: [{range: {start: {line: 0, character: 0}, end: textIndex(content).position(content.length)}, text: step.before[0].state.content}]});
    }
  }
  return changes.length ? parseWorkspaceEdit({formatVersion: 1, id, title, changes}) : null;
}
