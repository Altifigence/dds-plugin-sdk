import {languageCopy, languageObject, languageText, languageInteger, languageList, languageRange, textIndex, freezeLanguage, invalidLanguage, languageCall} from './language-values.mjs';
import {applyTextEdits} from './text-edits.mjs';

export const LANGUAGE_LIMITS = Object.freeze({
  signatures: 16, parameters: 64, signatureLabel: 2048, documentation: 16_384,
  snippetChars: 16_384, snippetStops: 128, additionalEdits: 32,
  resolveDataBytes: 4096, resolveTokens: 128, resolveBytes: 4_194_304,
  resolveTtlMs: 60_000, resolvePending: 4,
});

/** A bounded snippet subset. The result is plain text and positions, never executable content. */
export function parseSnippet(value) {
  const source = languageText(value, LANGUAGE_LIMITS.snippetChars, true);
  const segments = [], defaults = new Map(); let literal = '', count = 0, final = false;
  const flush = () => {if (literal) {segments.push({text: literal}); literal = '';}};
  for (let i = 0; i < source.length;) {
    if (source[i] === '\\') {
      if (!['\\', '$', '}', '{'].includes(source[i + 1])) invalidLanguage('Unsupported snippet escape');
      literal += source[i + 1]; i += 2; continue;
    }
    if (source[i] !== '$') {literal += source[i++]; continue;}
    flush(); i++;
    const braced = source[i] === '{'; if (braced) i++;
    const begin = i; while (/\d/.test(source[i] ?? '') && i < source.length) i++;
    const number = source.slice(begin, i);
    if (!/^(?:0|[1-9][0-9]?)$/.test(number)) invalidLanguage('Unsupported snippet expression');
    const index = Number(number); let defaultText;
    if (braced && source[i] === ':') {
      if (index === 0) invalidLanguage('Final tabstop cannot have a placeholder');
      i++; defaultText = '';
      while (i < source.length && source[i] !== '}') {
        if (source[i] === '\\') {
          if (!['\\', '$', '}', '{'].includes(source[i + 1])) invalidLanguage('Unsupported snippet escape');
          defaultText += source[i + 1]; i += 2;
        } else {
          if (source[i] === '$' || source[i] === '{') invalidLanguage('Nested snippets and variables are unsupported');
          defaultText += source[i++];
        }
      }
    }
    if (braced && source[i++] !== '}') invalidLanguage('Unclosed or unsupported snippet expression');
    if (++count > LANGUAGE_LIMITS.snippetStops) invalidLanguage('Snippet tabstop limit exceeded');
    if (index === 0) {if (final) invalidLanguage('Duplicate final tabstop'); final = true;}
    if (defaultText !== undefined) {
      if (defaults.has(index) && defaults.get(index) !== defaultText) invalidLanguage('Conflicting mirrored placeholders');
      defaults.set(index, defaultText);
    }
    segments.push({index});
  }
  flush();
  let text = ''; const groups = new Map();
  for (const segment of segments) {
    if (Object.hasOwn(segment, 'text')) {text += segment.text; continue;}
    const start = text.length; text += defaults.get(segment.index) ?? '';
    if (!groups.has(segment.index)) groups.set(segment.index, []);
    groups.get(segment.index).push({start, end: text.length});
    if (text.length > LANGUAGE_LIMITS.snippetChars) invalidLanguage('Expanded snippet limit exceeded');
  }
  languageText(text, LANGUAGE_LIMITS.snippetChars, true);
  if (!final) groups.set(0, [{start: text.length, end: text.length}]);
  const index = textIndex(text);
  for (const ranges of groups.values()) for (const range of ranges) {index.position(range.start); index.position(range.end);}
  return freezeLanguage({text, tabstops: [...groups].sort(([a], [b]) => (a || 100) - (b || 100)).map(([index, ranges]) => ({index, ranges}))});
}

export function parseCompletionItem(input) {
  const value = languageCopy(input, 131_072);
  languageObject(value, ['label', 'insertText'], ['detail', 'range', 'documentation', 'insertTextFormat', 'additionalTextEdits', 'resolveData', 'resolveToken']);
  const legacyText = (text, maximum, empty = false) => {
    languageText(text, maximum * 2, empty);
    if ([...text].length > maximum) invalidLanguage();
  };
  legacyText(value.label, 256); legacyText(value.insertText, 16_384, true);
  if (value.detail !== undefined) legacyText(value.detail, 2048);
  if (value.documentation !== undefined) languageText(value.documentation, LANGUAGE_LIMITS.documentation, true);
  if (value.range !== undefined) languageRange(value.range);
  if (value.insertTextFormat !== undefined && !['literal', 'snippet'].includes(value.insertTextFormat)) invalidLanguage();
  if (value.insertTextFormat === 'snippet') parseSnippet(value.insertText);
  if (value.additionalTextEdits !== undefined) for (const edit of languageList(value.additionalTextEdits, LANGUAGE_LIMITS.additionalEdits)) {
    languageObject(edit, ['range', 'text']); languageRange(edit.range); languageText(edit.text, 16_384, true);
  }
  if (value.resolveData !== undefined) languageCopy(value.resolveData, LANGUAGE_LIMITS.resolveDataBytes);
  if (value.resolveToken !== undefined && (typeof value.resolveToken !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.resolveToken))) invalidLanguage();
  return freezeLanguage(value);
}

export function parseLanguageContext(kind, input) {
  const value = languageCopy(input, 2048), signature = kind === 'signature-help';
  if (!signature && kind !== 'completion') invalidLanguage('Context is unsupported for this language feature');
  languageObject(value, signature ? ['triggerKind', 'isRetrigger'] : ['triggerKind'], signature ? ['triggerCharacter', 'activeSignature', 'activeParameter'] : ['triggerCharacter']);
  if (!(signature ? ['invoked', 'character', 'content-change'] : ['invoked', 'character', 'incomplete']).includes(value.triggerKind)) invalidLanguage();
  if (value.triggerKind === 'character') {
    languageText(value.triggerCharacter, 2); if ([...value.triggerCharacter].length !== 1 || /[\r\n\u0000]/.test(value.triggerCharacter)) invalidLanguage();
  } else if (value.triggerCharacter !== undefined) invalidLanguage();
  if (signature) {
    if (typeof value.isRetrigger !== 'boolean') invalidLanguage();
    for (const key of ['activeSignature', 'activeParameter']) if (value[key] !== undefined) {
      if (!value.isRetrigger) invalidLanguage();
      languageInteger(value[key], key === 'activeSignature' ? LANGUAGE_LIMITS.signatures - 1 : LANGUAGE_LIMITS.parameters - 1);
    }
  }
  return freezeLanguage(value);
}

export function parseSignatureHelp(input) {
  const value = languageCopy(input, 524_288); if (value === null) return null;
  languageObject(value, ['signatures', 'activeSignature', 'activeParameter']);
  for (const signature of languageList(value.signatures, LANGUAGE_LIMITS.signatures, 1)) {
    languageObject(signature, ['label', 'parameters'], ['documentation']); languageText(signature.label, LANGUAGE_LIMITS.signatureLabel);
    if (signature.documentation !== undefined) languageText(signature.documentation, LANGUAGE_LIMITS.documentation, true);
    const index = textIndex(signature.label);
    for (const parameter of languageList(signature.parameters, LANGUAGE_LIMITS.parameters)) {
      languageObject(parameter, ['label'], ['documentation']);
      languageList(parameter.label, 2, 2);
      const [start, end] = parameter.label;
      languageInteger(start, signature.label.length); languageInteger(end, signature.label.length, start + 1);
      index.position(start); index.position(end);
      if (parameter.documentation !== undefined) languageText(parameter.documentation, LANGUAGE_LIMITS.documentation, true);
    }
  }
  languageInteger(value.activeSignature, value.signatures.length - 1);
  const parameters = value.signatures[value.activeSignature].parameters;
  if (parameters.length) languageInteger(value.activeParameter, parameters.length - 1);
  else if (value.activeParameter !== null) invalidLanguage('Parameter must be null for a signature without parameters');
  return freezeLanguage(value);
}

export function completionEdits(request, item, index = textIndex(request.snapshot.text)) {
  const range = item.range ?? {start: request.position, end: request.position};
  index.range(range);
  const snippet = item.insertTextFormat === 'snippet' ? parseSnippet(item.insertText) : {text: item.insertText, tabstops: []};
  const edits = [{range, text: snippet.text}, ...(item.additionalTextEdits ?? [])];
  for (const edit of edits) index.range(edit.range);
  const content = languageCall(() => applyTextEdits(request.snapshot.text, edits));
  return {content, edits, snippet};
}

export function completionInsertion(request, item) {
  const original = textIndex(request.snapshot.text), {content, edits, snippet} = completionEdits(request, item, original);
  const mainStart = original.offset(edits[0].range.start);
  let shift = 0;
  for (const edit of edits.slice(1)) {
    const {start, end} = original.range(edit.range);
    if (start < mainStart) shift += edit.text.length - (end - start);
  }
  const updated = textIndex(content), base = mainStart + shift;
  const {text: _, ...snapshot} = request.snapshot;
  return freezeLanguage({snapshot, content, edits, tabstops: snippet.tabstops.map(stop => ({index: stop.index, ranges: stop.ranges.map(range => ({start: updated.position(base + range.start), end: updated.position(base + range.end)}))}))});
}
