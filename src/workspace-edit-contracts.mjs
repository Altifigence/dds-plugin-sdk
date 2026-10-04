import {copyWorkspaceJson, exactObject, requireUuid, requireText, requireSha256, requireWorkspacePath, requireFileContent, workspaceFailure, WORKSPACE_ERROR_CODES} from './workspace-values.mjs';
import {languageRange} from './language-values.mjs';
import {applyTextEdits} from './text-edits.mjs';
import {createIncrementalSha256} from './sha256-stream.mjs';

export const WORKSPACE_EDIT_LIMITS = Object.freeze({changes: 32, edits: 1000, proposalBytes: 1_048_576, previewBytes: 8_388_608, journalRecords: 64, journalBytes: 67_108_864});
export const WORKSPACE_EDIT_CAPABILITIES = Object.freeze({formatVersion: 1, kinds: Object.freeze(['edit', 'create', 'move', 'delete']), atomicity: 'per-file', recovery: 'readback-only', limits: WORKSPACE_EDIT_LIMITS});
export const editFailure = code => workspaceFailure(code, 'Workspace edit operation could not be completed');
export const editCopy = (value, maxBytes = WORKSPACE_EDIT_LIMITS.previewBytes) => copyWorkspaceJson(value, {maxBytes, maxNodes: 100_000, maxDepth: 24});
export const editHash = text => createIncrementalSha256().update(new TextEncoder().encode(text)).digest();
export function canonicalEditJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalEditJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalEditJson(value[key])).join(',') + '}';
}
const invalid = () => {throw editFailure('invalid_request');};
function list(value, maximum, minimum = 0) {if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(); return value;}
export function parseWorkspaceEdit(input) {
  const value = editCopy(input, WORKSPACE_EDIT_LIMITS.proposalBytes);
  exactObject(value, ['formatVersion', 'id', 'title', 'changes']);
  if (value.formatVersion !== 1) invalid(); requireUuid(value.id); requireText(value.title, 256);
  let edits = 0; const paths = [];
  for (const change of list(value.changes, WORKSPACE_EDIT_LIMITS.changes, 1)) {
    const fields = {edit: ['baseRevision', 'edits'], create: ['content'], move: ['baseRevision', 'newPath'], delete: ['baseRevision']}[change?.kind];
    if (!fields) invalid();
    exactObject(change, ['kind', 'path', ...fields], ['reason']);
    requireWorkspacePath(change.path); paths.push(change.path.toLowerCase());
    if (change.reason !== undefined) requireText(change.reason, 2048);
    if (change.kind !== 'create') requireSha256(change.baseRevision);
    if (change.kind === 'create') requireFileContent(change.content);
    if (change.kind === 'move') {requireWorkspacePath(change.newPath); paths.push(change.newPath.toLowerCase());}
    if (change.kind === 'edit') for (const edit of list(change.edits, 500, 1)) {
      if (++edits > WORKSPACE_EDIT_LIMITS.edits) throw editFailure('budget_exceeded');
      exactObject(edit, ['range', 'text']);
      try {languageRange(edit.range);} catch {invalid();}
      requireFileContent(edit.text);
    }
  }
  const distinct = new Set(paths);
  // A proposal has disjoint paths on every platform; directory operations and
  // dependent chains must be separately reviewed plans with fresh revisions.
  if (distinct.size !== paths.length) invalid();
  for (const file of paths) {
    const parts = file.split('/'); parts.pop();
    while (parts.length) {if (distinct.has(parts.join('/'))) invalid(); parts.pop();}
  }
  return value;
}
export const changePaths = change => change.kind === 'move' ? [change.path, change.newPath] : [change.path];
export const contentState = content => content === null ? null : {content, revision: editHash(requireFileContent(content))};
export function parseEditFileState(value) {
  if (value === null) return null;
  exactObject(value, ['content', 'revision']); requireFileContent(value.content); requireSha256(value.revision);
  if (editHash(value.content) !== value.revision) throw editFailure('conflict');
  return value;
}
export function textDifference(before, after) {
  before ??= ''; after ??= ''; let start = 0, end = 0;
  const boundary = (text, offset) => !(offset > 0 && offset < text.length && (/^[\uD800-\uDBFF]$/.test(text[offset - 1]) && /^[\uDC00-\uDFFF]$/.test(text[offset]) || text[offset - 1] === '\r' && text[offset] === '\n'));
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (start && (!boundary(before, start) || !boundary(after, start))) start--;
  while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  while (end && (!boundary(before, before.length - end) || !boundary(after, after.length - end))) end--;
  return {start, deleteCount: before.length - start - end, insertText: after.slice(start, after.length - end)};
}

/** Derive a reproducible preview entirely from validated original file snapshots. */
export function buildEditPreview(edit, workspace, originals) {
  edit = parseWorkspaceEdit(edit); exactObject(workspace, ['id', 'generation']); requireUuid(workspace.id); requireUuid(workspace.generation);
  list(originals, WORKSPACE_EDIT_LIMITS.changes * 2);
  const expected = edit.changes.flatMap(changePaths);
  if (originals.length !== expected.length) invalid();
  const byPath = new Map();
  for (let n = 0; n < originals.length; n++) {
    const file = originals[n]; exactObject(file, ['path', 'state']);
    if (file.path !== expected[n]) invalid();
    byPath.set(file.path, parseEditFileState(file.state));
  }
  const conflicts = [], steps = [];
  const conflict = (path, code) => conflicts.push({path, code});
  for (let index = 0; index < edit.changes.length; index++) {
    const change = edit.changes[index], before = changePaths(change).map(path => ({path, state: byPath.get(path)}));
    const source = before[0].state, previousConflicts = conflicts.length; let after = null;
    if (change.kind === 'create') {
      if (source !== null) conflict(change.path, 'destination_exists');
      else after = [{path: change.path, state: contentState(change.content)}];
    } else {
      if (source === null) conflict(change.path, 'source_missing');
      else if (source.revision !== change.baseRevision) conflict(change.path, 'revision_changed');
      if (change.kind === 'move' && before[1].state !== null) conflict(change.newPath, 'destination_exists');
      if (conflicts.length === previousConflicts) {
        if (change.kind === 'edit') {
          const state = contentState(applyTextEdits(source.content, change.edits));
          if (state.revision === source.revision) conflict(change.path, 'no_change');
          else after = [{path: change.path, state}];
        } else if (change.kind === 'delete') after = [{path: change.path, state: null}];
        else after = [{path: change.path, state: null}, {path: change.newPath, state: source}];
      }
    }
    steps.push({index, before, after, diff: after === null ? [] : after.map((file, n) => ({path: file.path, change: textDifference(before[n].state?.content ?? null, file.state?.content ?? null)}))});
  }
  const requiredCapabilities = ['write', ...(edit.changes.some(change => ['move', 'delete'].includes(change.kind)) ? ['manage'] : [])];
  const payload = editCopy({formatVersion: 1, planId: edit.id, workspace, edit, requiredCapabilities, ready: conflicts.length === 0, conflicts, steps});
  return editCopy({...payload, digest: editHash(canonicalEditJson(payload))});
}
export function parseWorkspaceEditPreview(input) {
  const value = editCopy(input);
  exactObject(value, ['formatVersion', 'planId', 'workspace', 'edit', 'requiredCapabilities', 'ready', 'conflicts', 'steps', 'digest']);
  requireSha256(value.digest);
  list(value.steps, WORKSPACE_EDIT_LIMITS.changes, 1);
  const originals = value.steps.flatMap(step => {
    exactObject(step, ['index', 'before', 'after', 'diff']); return list(step.before, 2, 1);
  });
  const derived = buildEditPreview(value.edit, value.workspace, originals);
  if (canonicalEditJson(value) !== canonicalEditJson(derived)) throw editFailure('conflict');
  return derived;
}
export function parseWorkspaceEditRecord(input) {
  const value = editCopy(input, WORKSPACE_EDIT_LIMITS.previewBytes + 65_536);
  exactObject(value, ['formatVersion', 'preview', 'revision', 'phase', 'steps', 'updatedAt']);
  const preview = parseWorkspaceEditPreview(value.preview);
  if (value.formatVersion !== 1 || !preview.ready || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0 || !['applying', 'completed', 'stopped'].includes(value.phase)) invalid();
  if (list(value.steps, WORKSPACE_EDIT_LIMITS.changes, 1).length !== preview.steps.length) invalid();
  let encounteredPending = false, intents = 0;
  for (const step of value.steps) {
    exactObject(step, ['state'], ['errorCode']);
    if (!['pending', 'intent', 'applied', 'not-applied', 'conflicted', 'unknown'].includes(step.state)) invalid();
    if (step.errorCode !== undefined && !WORKSPACE_ERROR_CODES.includes(step.errorCode)) invalid();
    if (step.state === 'pending') encounteredPending = true;
    else if (encounteredPending) invalid();
    if (step.state === 'intent') intents++;
  }
  if (intents > 1 || value.phase === 'completed' && value.steps.some(step => step.state !== 'applied')) invalid();
  return value;
}

export function parseWorkspaceEditReceipt(input) {
  const value = editCopy(input, 65_536);
  exactObject(value, ['formatVersion', 'planId', 'digest', 'workspaceId', 'status', 'steps'], ['executionStopped', 'errorCode', 'journalError', 'currentGeneration', 'journalPhase', 'journalRevision']);
  requireUuid(value.planId); requireUuid(value.workspaceId); requireSha256(value.digest);
  if (value.formatVersion !== 1) invalid();
  for (const [index, step] of list(value.steps, WORKSPACE_EDIT_LIMITS.changes, 1).entries()) {
    exactObject(step, ['index', 'state', 'canCompensate'], ['errorCode']);
    if (step.index !== index || !['applied', 'not-applied', 'conflicted', 'unknown'].includes(step.state) || step.canCompensate !== (step.state === 'applied') || step.errorCode !== undefined && !WORKSPACE_ERROR_CODES.includes(step.errorCode)) invalid();
  }
  const applied = value.steps.filter(step => step.state === 'applied').length;
  const expected = value.steps.some(step => ['unknown', 'conflicted'].includes(step.state)) ? 'uncertain' : applied === value.steps.length ? 'completed' : applied ? 'partial' : 'not-applied';
  if (value.status !== expected) invalid();
  for (const key of ['errorCode', 'journalError']) if (value[key] !== undefined && !WORKSPACE_ERROR_CODES.includes(value[key])) invalid();
  if (value.executionStopped !== undefined) {
    if (typeof value.executionStopped !== 'boolean' || ['currentGeneration', 'journalPhase', 'journalRevision'].some(key => value[key] !== undefined)) invalid();
    if (!value.executionStopped && (value.status !== 'completed' || value.errorCode !== undefined || value.journalError !== undefined)) invalid();
  } else {
    requireUuid(value.currentGeneration);
    if (!['applying', 'completed', 'stopped'].includes(value.journalPhase) || !Number.isSafeInteger(value.journalRevision) || value.journalRevision < 1 || value.errorCode !== undefined || value.journalError !== undefined) invalid();
  }
  return value;
}
