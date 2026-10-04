import {copyWorkspaceJson} from './workspace-values.mjs';
import {languageCopy, languageObject, languageText, languageInteger, languageList, languageRange, languagePosition, compareLanguagePosition, textIndex, freezeLanguage, invalidLanguage, languageCall} from './language-values.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';

export const SEMANTIC_STYLE_KEYS = Object.freeze(['plain', 'keyword', 'type', 'function', 'variable', 'number', 'string', 'comment', 'operator']);
export const LANGUAGE_DISPLAY_LIMITS = Object.freeze({semanticTokens: 20_000, tokenTypes: 64, tokenModifiers: 16, deltaEdits: 64, semanticCacheEntries: 8, semanticCacheBytes: 4_194_304, semanticCacheTtlMs: 60_000, foldingRanges: 1000, foldingDepth: 32, inlayHints: 1000, symbols: 1000, symbolDepth: 16});
export const DISPLAY_SYMBOL_KINDS = Object.freeze(['module', 'namespace', 'class', 'interface', 'function', 'method', 'variable', 'constant', 'property', 'type']);
const numericLimit = LANGUAGE_DISPLAY_LIMITS.semanticTokens * 5;
const budget = () => {throw new PluginSdkError(ErrorCode.BUDGET_EXCEEDED, 'Language display budget exceeded');};
const displayCopy = (input, maxDepth = 24) => languageCall(() => copyWorkspaceJson(input, {maxBytes: 1_600_000, maxDepth, maxNodes: 150_000}));
function displayList(value, maximum, minimum = 0) {if (Array.isArray(value) && value.length > maximum) budget(); return languageList(value, maximum, minimum);}
function opaqueId(value) {languageText(value, 128); if (/[\u0000-\u001f\u007f]/.test(value)) invalidLanguage(); return value;}
function legendName(value) {languageText(value, 64); if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) invalidLanguage();}
function integerData(value) {for (const item of displayList(value, numericLimit)) languageInteger(item, 0x7fffffff); return value;}
export function parseSemanticLegend(input) {
  const value = languageCopy(input, 16_384); languageObject(value, ['tokenTypes', 'tokenModifiers']);
  const names = new Set();
  for (const type of displayList(value.tokenTypes, LANGUAGE_DISPLAY_LIMITS.tokenTypes, 1)) {
    languageObject(type, ['name', 'style']); legendName(type.name);
    if (names.has(type.name) || !SEMANTIC_STYLE_KEYS.includes(type.style)) invalidLanguage(); names.add(type.name);
  }
  const modifiers = displayList(value.tokenModifiers, LANGUAGE_DISPLAY_LIMITS.tokenModifiers);
  for (const name of modifiers) legendName(name);
  if (new Set(modifiers).size !== modifiers.length) invalidLanguage();
  return value;
}
const parsedSemantic = new WeakSet();
export function parseSemanticTokens(input) {
  if (parsedSemantic.has(input)) return input;
  const value = displayCopy(input); languageObject(value, ['resultId', 'legend', 'data'], ['updateKind']);
  opaqueId(value.resultId); parseSemanticLegend(value.legend); integerData(value.data);
  if (value.data.length % 5 !== 0 || value.updateKind !== undefined && !['full', 'delta', 'fallback'].includes(value.updateKind)) invalidLanguage();
  parsedSemantic.add(value); return value;
}
export function parseSemanticTokensDelta(input) {
  const value = displayCopy(input); languageObject(value, ['baseResultId', 'resultId', 'edits']); opaqueId(value.baseResultId); opaqueId(value.resultId);
  let added = 0, end = 0, previousStart = -1;
  for (const edit of displayList(value.edits, LANGUAGE_DISPLAY_LIMITS.deltaEdits)) {
    languageObject(edit, ['start', 'deleteCount'], ['data']); languageInteger(edit.start, numericLimit); languageInteger(edit.deleteCount, numericLimit);
    if (edit.start < end || edit.start === previousStart) invalidLanguage('Semantic delta edits overlap or share an insertion point');
    end = edit.start + edit.deleteCount; previousStart = edit.start;
    if (edit.data !== undefined) added += integerData(edit.data).length;
    if (added > numericLimit) budget();
  }
  return value;
}
function visitSemantic(input, content, collect) {
  const value = parseSemanticTokens(input), index = textIndex(content), tokens = [];
  let line = 0, character = 0, previousEnd;
  for (let n = 0; n < value.data.length; n += 5) {
    const [deltaLine, deltaStart, length, type, modifiers] = value.data.slice(n, n + 5);
    line += deltaLine; character = deltaLine === 0 ? character + deltaStart : deltaStart;
    if (!length || type >= value.legend.tokenTypes.length || modifiers >= 2 ** value.legend.tokenModifiers.length) invalidLanguage('Semantic token legend reference is invalid');
    const range = {start: {line, character}, end: {line, character: character + length}}; index.range(range);
    if (previousEnd && compareLanguagePosition(previousEnd, range.start) > 0) invalidLanguage('Semantic tokens overlap');
    previousEnd = range.end;
    if (collect) tokens.push({range, type: value.legend.tokenTypes[type].name, style: value.legend.tokenTypes[type].style, modifiers: value.legend.tokenModifiers.filter((_name, bit) => modifiers & 2 ** bit)});
  }
  return collect ? freezeLanguage(tokens) : value;
}
export const validateSemanticTokens = (value, content) => visitSemantic(value, content, false);
export const decodeSemanticTokens = (value, content) => visitSemantic(value, content, true);
export function applySemanticTokensDelta(baseInput, deltaInput, content) {
  const base = parseSemanticTokens(baseInput), delta = parseSemanticTokensDelta(deltaInput);
  if (delta.baseResultId !== base.resultId) throw new PluginSdkError(ErrorCode.STALE_SNAPSHOT, 'Semantic delta base does not match');
  let cursor = 0, length = base.data.length; const parts = [];
  for (const edit of delta.edits) {
    if (edit.start + edit.deleteCount > base.data.length) invalidLanguage('Semantic delta range exceeds the base');
    length += (edit.data?.length ?? 0) - edit.deleteCount;
    parts.push(base.data.slice(cursor, edit.start), edit.data ?? []); cursor = edit.start + edit.deleteCount;
  }
  if (length > numericLimit) budget();
  parts.push(base.data.slice(cursor));
  const value = parseSemanticTokens({resultId: delta.resultId, legend: base.legend, data: parts.flat()});
  validateSemanticTokens(value, content); return value;
}

export function parseFoldingRanges(input) {
  const values = languageCopy(input), stack = []; let previous;
  for (const item of displayList(values, LANGUAGE_DISPLAY_LIMITS.foldingRanges)) {
    languageObject(item, ['range'], ['kind', 'collapsedText']); languageRange(item.range);
    if (compareLanguagePosition(item.range.start, item.range.end) >= 0) invalidLanguage('Fold range must be nonempty');
    if (item.kind !== undefined && !['region', 'comment', 'imports'].includes(item.kind)) invalidLanguage();
    if (item.collapsedText !== undefined) languageText(item.collapsedText, 256);
    if (previous && (compareLanguagePosition(previous.start, item.range.start) > 0 || compareLanguagePosition(previous.start, item.range.start) === 0 && compareLanguagePosition(previous.end, item.range.end) <= 0)) invalidLanguage('Fold ranges must be ordered outer-first');
    while (stack.length && compareLanguagePosition(stack.at(-1).end, item.range.start) <= 0) stack.pop();
    if (stack.length && compareLanguagePosition(item.range.end, stack.at(-1).end) > 0) invalidLanguage('Fold ranges cross');
    if (stack.length >= LANGUAGE_DISPLAY_LIMITS.foldingDepth) budget();
    stack.push(item.range); previous = item.range;
  }
  return values;
}
export function parseInlayHints(input) {
  const values = languageCopy(input); let previous;
  for (const item of displayList(values, LANGUAGE_DISPLAY_LIMITS.inlayHints)) {
    languageObject(item, ['position', 'label'], ['kind', 'paddingLeft', 'paddingRight', 'tooltip']); languagePosition(item.position); languageText(item.label, 1024);
    if (/[\r\n\u0000]/.test(item.label) || item.kind !== undefined && !['type', 'parameter'].includes(item.kind)) invalidLanguage();
    for (const key of ['paddingLeft', 'paddingRight']) if (item[key] !== undefined && typeof item[key] !== 'boolean') invalidLanguage();
    if (item.tooltip !== undefined) languageText(item.tooltip, 4096, true);
    if (previous && compareLanguagePosition(previous, item.position) > 0) invalidLanguage('Inlay hints must be sorted'); previous = item.position;
  }
  return values;
}
export function parseDocumentSymbolTree(input) {
  const values = displayCopy(input, 64); let count = 0;
  function read(siblings, parent, depth) {
    if (depth > LANGUAGE_DISPLAY_LIMITS.symbolDepth) budget();
    let previous;
    for (const item of displayList(siblings, LANGUAGE_DISPLAY_LIMITS.symbols)) {
      if (++count > LANGUAGE_DISPLAY_LIMITS.symbols) budget();
      languageObject(item, ['name', 'kind', 'range', 'selectionRange'], ['detail', 'children']);
      languageText(item.name, 256); if (!DISPLAY_SYMBOL_KINDS.includes(item.kind)) invalidLanguage();
      languageRange(item.range); languageRange(item.selectionRange);
      if (item.detail !== undefined) languageText(item.detail, 2048);
      if (compareLanguagePosition(item.range.start, item.range.end) >= 0 || compareLanguagePosition(item.range.start, item.selectionRange.start) > 0 || compareLanguagePosition(item.selectionRange.end, item.range.end) > 0) invalidLanguage('Symbol selection must lie within its range');
      if (parent && (compareLanguagePosition(parent.start, item.range.start) > 0 || compareLanguagePosition(item.range.end, parent.end) > 0)) invalidLanguage('Child symbol is outside its parent');
      if (previous && compareLanguagePosition(previous.end, item.range.start) > 0) invalidLanguage('Sibling symbols overlap or are out of order');
      if (item.children !== undefined) {
        displayList(item.children, LANGUAGE_DISPLAY_LIMITS.symbols);
        if (item.children.length) read(item.children, item.range, depth + 1);
      }
      previous = item.range;
    }
  }
  read(values, undefined, 1); return values;
}
export function validateLanguageDisplay(request, data) {
  if (request.kind === 'semantic-tokens') {validateSemanticTokens(data, request.snapshot.text); return;}
  const index = textIndex(request.snapshot.text);
  if (request.kind === 'folding-ranges') {for (const item of data) index.range(item.range); return;}
  if (request.kind === 'inlay-hints') {
    for (const item of data) {
      index.offset(item.position);
      if (compareLanguagePosition(item.position, request.range.start) < 0 || compareLanguagePosition(item.position, request.range.end) > 0) invalidLanguage('Inlay hint is outside the selected range');
    }
    return;
  }
  function walk(items) {for (const item of items) {index.range(item.range); index.range(item.selectionRange); if (item.children) walk(item.children);}}
  walk(data);
}
