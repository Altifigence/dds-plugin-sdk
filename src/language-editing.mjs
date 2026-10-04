import {languageCopy, languageObject, languageText, languageInteger, languageList, compareLanguagePosition, textIndex, invalidLanguage, languageCall} from './language-values.mjs';
import {parseWorkspaceEdit, canonicalEditJson, editHash} from './workspace-edit-contracts.mjs';
import {applyTextEdits} from './text-edits.mjs';
import {LANGUAGE_LIMITS} from './language-assistance.mjs';

export const CODE_ACTION_KINDS = Object.freeze(['quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source.organizeImports', 'source.fixAll']);
export const LANGUAGE_EDIT_LIMITS = Object.freeze({actions: 100, diagnosticIndices: 500, title: 256, disabledReason: 2048, tabSize: 16});
export function parseFormattingOptions(input) {
  const value = languageCopy(input, 2048);
  languageObject(value, ['tabSize', 'insertSpaces'], ['trimTrailingWhitespace', 'insertFinalNewline', 'trimFinalNewlines', 'endOfLine']);
  languageInteger(value.tabSize, LANGUAGE_EDIT_LIMITS.tabSize, 1);
  for (const key of ['insertSpaces', 'trimTrailingWhitespace', 'insertFinalNewline', 'trimFinalNewlines']) if (value[key] !== undefined && typeof value[key] !== 'boolean') invalidLanguage();
  if (value.endOfLine !== undefined && !['preserve', 'lf', 'crlf'].includes(value.endOfLine)) invalidLanguage();
  return value;
}
export function parseCodeActionContext(input = {triggerKind: 'invoked'}) {
  const value = languageCopy(input, 2048); languageObject(value, ['triggerKind'], ['only']);
  if (!['invoked', 'automatic'].includes(value.triggerKind)) invalidLanguage();
  if (value.only !== undefined) {
    for (const kind of languageList(value.only, CODE_ACTION_KINDS.length, 1)) if (!CODE_ACTION_KINDS.includes(kind)) invalidLanguage();
    if (new Set(value.only).size !== value.only.length) invalidLanguage();
  }
  return value;
}
export function parseCodeAction(input) {
  const value = languageCopy(input, 1_100_000);
  languageObject(value, ['title', 'kind'], ['isPreferred', 'disabled', 'diagnosticIndices', 'edit', 'resolveData', 'resolveToken']);
  languageText(value.title, LANGUAGE_EDIT_LIMITS.title);
  if (!CODE_ACTION_KINDS.includes(value.kind) || value.isPreferred !== undefined && typeof value.isPreferred !== 'boolean') invalidLanguage();
  if (value.diagnosticIndices !== undefined) {
    for (const index of languageList(value.diagnosticIndices, LANGUAGE_EDIT_LIMITS.diagnosticIndices)) languageInteger(index, LANGUAGE_EDIT_LIMITS.diagnosticIndices - 1);
    if (new Set(value.diagnosticIndices).size !== value.diagnosticIndices.length) invalidLanguage();
  }
  if (value.disabled !== undefined) {
    languageObject(value.disabled, ['reason']); languageText(value.disabled.reason, LANGUAGE_EDIT_LIMITS.disabledReason);
    if (value.edit !== undefined || value.resolveData !== undefined || value.resolveToken !== undefined) invalidLanguage('Disabled actions cannot carry an edit or resolver');
  } else if (value.edit === undefined && value.resolveData === undefined && value.resolveToken === undefined) invalidLanguage('Action requires a proposed edit or resolver');
  if (value.edit !== undefined) languageCall(() => parseWorkspaceEdit(value.edit));
  if (value.resolveData !== undefined) languageCopy(value.resolveData, LANGUAGE_LIMITS.resolveDataBytes);
  if (value.resolveToken !== undefined && (typeof value.resolveToken !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.resolveToken))) invalidLanguage();
  return value;
}
export function parseCodeActions(input) {
  const values = languageCopy(input);
  return Object.freeze(languageList(values, LANGUAGE_EDIT_LIMITS.actions).map(parseCodeAction));
}
export function sameCodeActionSelection(a, b) {
  return a.title === b.title && a.kind === b.kind && (a.isPreferred ?? false) === (b.isPreferred ?? false) && canonicalEditJson(a.diagnosticIndices ?? []) === canonicalEditJson(b.diagnosticIndices ?? []);
}
export function validateActionEdit(request, edit) {
  for (const change of edit.changes) if (change.path === request.path) {
    if (change.baseRevision !== undefined && change.baseRevision !== editHash(request.snapshot.text)) invalidLanguage('Action edit has a different current-document base');
    if (change.kind === 'edit') languageCall(() => applyTextEdits(request.snapshot.text, change.edits));
  }
}
export function validateCodeActions(request, items) {
  for (const item of items) {
    if (request.context?.only && !request.context.only.some(kind => item.kind === kind || item.kind.startsWith(kind + '.'))) invalidLanguage('Action kind does not match the requested filter');
    for (const index of item.diagnosticIndices ?? []) if (index >= request.diagnosticContext.diagnostics.length) invalidLanguage('Action diagnostic reference is outside the current bundle');
    if (item.edit !== undefined) validateActionEdit(request, item.edit);
  }
}
/** Validate scope and newline policy; return whether the formatter changes content. */
export function validateFormattingEdit(request, edit) {
  if (edit === null) return false;
  if (edit.changes.length !== 1) invalidLanguage('Formatting affects one current document');
  const change = edit.changes[0];
  if (change.kind !== 'edit' || change.path !== request.path || change.baseRevision !== editHash(request.snapshot.text)) invalidLanguage('Formatting must match the current file snapshot');
  const index = textIndex(request.snapshot.text);
  for (const item of change.edits) {
    index.range(item.range);
    if (request.kind === 'format-range' && (compareLanguagePosition(item.range.start, request.range.start) < 0 || compareLanguagePosition(item.range.end, request.range.end) > 0)) invalidLanguage('Formatting edit is outside the selected range');
  }
  const content = languageCall(() => applyTextEdits(request.snapshot.text, change.edits));
  const originalEndings = [...request.snapshot.text.matchAll(/\r\n|\r|\n/g)].map(match => match[0]);
  const policy = request.formatOptions.endOfLine ?? 'preserve';
  const allowed = new Set(policy === 'lf' ? ['\n'] : policy === 'crlf' ? ['\r\n'] : originalEndings.length ? originalEndings : ['\n']);
  for (const item of change.edits) if ([...item.text.matchAll(/\r\n|\r|\n/g)].some(match => !allowed.has(match[0]))) invalidLanguage('Formatter changed the requested line ending policy');
  return content !== request.snapshot.text;
}
