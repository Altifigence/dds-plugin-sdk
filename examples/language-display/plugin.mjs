import {definePlugin, createLanguageResult} from '@altifigence/dds-plugin-sdk';

export const sample = 'module counter {\n  let count = 12;\n  let title = "😀";\n}\n';
export const literalHint = '<img src=x onerror=alert(1)>';
const legend = {tokenTypes: [{name: 'keyword', style: 'keyword'}, {name: 'identifier', style: 'variable'}, {name: 'number', style: 'number'}, {name: 'string', style: 'string'}], tokenModifiers: []};
const range = (line, start, end) => ({start: {line, character: start}, end: {line, character: end}});
const compare = (a, b) => a.line - b.line || a.character - b.character;
// A deliberately small teaching grammar. Real languages own their parser and licensing.
function analyze(text) {
  const lines = text.split(/\r\n|\r|\n/), data = [], hints = [], children = [];
  let previousLine = 0, previousStart = 0;
  for (const [line, content] of lines.entries()) {
    for (const match of content.matchAll(/"[^"\r\n]*"|\b(?:module|let)\b|\b\d+\b|[A-Za-z_]\w*/g)) {
      const type = ['module', 'let'].includes(match[0]) ? 0 : match[0].startsWith('"') ? 3 : /^\d/.test(match[0]) ? 2 : 1;
      data.push(line - previousLine, line === previousLine ? match.index - previousStart : match.index, match[0].length, type, 0);
      previousLine = line; previousStart = match.index;
    }
    const declaration = /\blet\s+([A-Za-z_]\w*)\s*=\s*(.+);/.exec(content);
    if (declaration) {
      const start = content.indexOf(declaration[1], declaration.index + 3), end = start + declaration[1].length;
      children.push({name: declaration[1], kind: 'variable', range: range(line, declaration.index, declaration.index + declaration[0].length), selectionRange: range(line, start, end)});
      hints.push({position: {line, character: end}, label: /^\d/.test(declaration[2]) ? ': number' : literalHint, kind: 'type', paddingLeft: true, tooltip: 'Literal teaching hint. No HTML or command is evaluated.'});
    }
  }
  const opening = lines.findIndex(line => /^module\s+\w+\s*\{/.test(line)), closing = lines.findLastIndex(line => /^\}/.test(line));
  const folds = [], symbols = [];
  if (opening >= 0 && closing > opening) {
    const module = /^module\s+(\w+)/.exec(lines[opening]), start = lines[opening].indexOf(module[1]);
    const whole = {start: {line: opening, character: 0}, end: {line: closing, character: 1}};
    folds.push({range: whole, kind: 'region', collapsedText: 'module ' + module[1] + ' …'});
    symbols.push({name: module[1], kind: 'module', range: whole, selectionRange: range(opening, start, start + module[1].length), children: children.filter(child => child.range.start.line > opening && child.range.end.line < closing)});
  }
  return {data, hints, folds, symbols};
}

export function createTeachingDisplayPlugin(counters = {full: 0, delta: 0}) {
  let sequence = 0;
  return definePlugin({manifestVersion: 2, id: 'teaching-display', name: 'Teaching Display', publisher: 'example', version: '1.0.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'}, supportedHosts: ['test-host'], capabilities: ['semantic-tokens', 'semantic-tokens-delta', 'folding-ranges', 'inlay-hints', 'document-symbol-tree'], permissions: ['document.read', 'language.provide']}, context => {
    context.registerLanguageProvider('semantic-tokens', {languages: ['teaching']}, {
      provide(request, {signal}) {signal.throwIfAborted(); counters.full++; return createLanguageResult(request, {resultId: `tokens-${++sequence}`, legend, data: analyze(request.snapshot.text).data});},
      provideDelta(request, previous, {signal}) {
        signal.throwIfAborted(); counters.delta++;
        const next = analyze(request.snapshot.text).data; let start = 0, oldEnd = previous.data.length, newEnd = next.length;
        while (start < oldEnd && start < newEnd && previous.data[start] === next[start]) start++;
        while (oldEnd > start && newEnd > start && previous.data[oldEnd - 1] === next[newEnd - 1]) {oldEnd--; newEnd--;}
        return {baseResultId: previous.resultId, resultId: `tokens-${++sequence}`, edits: start === oldEnd && start === newEnd ? [] : [{start, deleteCount: oldEnd - start, data: next.slice(start, newEnd)}]};
      },
    });
    for (const [kind, key] of [['folding-ranges', 'folds'], ['inlay-hints', 'hints'], ['document-symbol-tree', 'symbols']]) context.registerLanguageProvider(kind, {languages: ['teaching']}, {provide(request, {signal}) {
      signal.throwIfAborted(); let values = analyze(request.snapshot.text)[key];
      if (kind === 'inlay-hints') values = values.filter(hint => compare(hint.position, request.range.start) >= 0 && compare(hint.position, request.range.end) <= 0);
      return createLanguageResult(request, values);
    }});
  });
}
