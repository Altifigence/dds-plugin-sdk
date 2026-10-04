import {copyWorkspaceJson, exactObject, requireFileContent} from './workspace-values.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';

export const invalidLanguage = (message = 'Invalid language contract') => {throw new PluginSdkError(ErrorCode.INVALID_CONTRACT, message);};
export function languageCall(operation) {
  try {return operation();}
  catch (error) {
    if (error instanceof PluginSdkError) throw error;
    throw new PluginSdkError(error?.code === 'budget_exceeded' ? ErrorCode.BUDGET_EXCEEDED : ErrorCode.INVALID_CONTRACT, 'Invalid language contract');
  }
}
export const languageCopy = (value, maxBytes = 1_600_000) => languageCall(() => copyWorkspaceJson(value, {maxBytes, maxNodes: 60_000, maxDepth: 24}));
export const languageObject = (value, required, optional = []) => languageCall(() => exactObject(value, required, optional));
export function languageText(value, maximum, empty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > maximum || !empty && !value.length) invalidLanguage();
  return value;
}
export function languageInteger(value, maximum, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalidLanguage();
  return value;
}
export function languageList(value, maximum, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalidLanguage();
  return value;
}
export function freezeLanguage(value) {
  if (value && typeof value === 'object') {for (const item of Object.values(value)) freezeLanguage(item); Object.freeze(value);}
  return value;
}
export function languagePosition(value) {
  languageObject(value, ['line', 'character']);
  languageInteger(value.line, 262_144); languageInteger(value.character, 262_144);
  return value;
}
export const compareLanguagePosition = (a, b) => a.line - b.line || a.character - b.character;
export function languageRange(value) {
  languageObject(value, ['start', 'end']); languagePosition(value.start); languagePosition(value.end);
  if (compareLanguagePosition(value.start, value.end) > 0) invalidLanguage('Language range is reversed');
  return value;
}
export function textIndex(content) {
  languageCall(() => requireFileContent(content));
  const starts = [0], ends = [];
  for (const newline of content.matchAll(/\r\n|\r|\n/g)) {ends.push(newline.index); starts.push(newline.index + newline[0].length);}
  ends.push(content.length);
  function boundary(index) {
    const before = content.charCodeAt(index - 1), after = content.charCodeAt(index);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) invalidLanguage('Position splits a Unicode character');
  }
  function offset(position) {
    languagePosition(position);
    if (position.line >= starts.length || position.character > ends[position.line] - starts[position.line]) invalidLanguage('Position is outside the document');
    const index = starts[position.line] + position.character; boundary(index); return index;
  }
  function position(index) {
    languageInteger(index, content.length); boundary(index);
    let lo = 0, hi = starts.length;
    while (lo + 1 < hi) {const mid = (lo + hi) >>> 1; if (starts[mid] <= index) lo = mid; else hi = mid;}
    if (index > ends[lo]) invalidLanguage('Position splits a CRLF newline');
    return {line: lo, character: index - starts[lo]};
  }
  return {offset, position, range(value) {languageRange(value); return {start: offset(value.start), end: offset(value.end)};}};
}
