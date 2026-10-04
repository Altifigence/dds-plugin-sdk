import {definePlugin, createDiagnosticsResult, createLanguageResult} from '@altifigence/dds-plugin-sdk';

const compare = (a, b) => a.line - b.line || a.character - b.character;
async function editPlan(request, edits, title) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.snapshot.text)));
  const baseRevision = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return {formatVersion: 1, id: crypto.randomUUID(), title, changes: [{kind: 'edit', path: request.path, baseRevision, edits}]};
}
export default definePlugin({
  manifestVersion: 2, id: 'teaching-editing', name: 'Teaching Editing', publisher: 'example', version: '1.0.0',
  protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', supportedHosts: ['test-host'], license: 'Apache-2.0',
  source: {visibility: 'open', licenseFile: 'LICENSE'},
  capabilities: ['diagnostics', 'format-document', 'format-range', 'code-actions', 'code-action-resolve'],
  permissions: ['document.read', 'diagnostics.publish', 'language.provide'],
}, context => {
  context.registerDiagnosticsProvider({languages: ['teaching']}, {provideDiagnostics(request) {
    const diagnostics = [];
    request.snapshot.text.split(/\r\n|\r|\n/).forEach((line, number) => {
      for (const match of line.matchAll(/\bTODO\b/g)) diagnostics.push({range: {start: {line: number, character: match.index}, end: {line: number, character: match.index + 4}}, severity: 'info', code: 'todo', source: 'teaching', message: 'Replace this TODO when the work is finished.'});
    });
    return createDiagnosticsResult(request, diagnostics);
  }});
  const formatter = {async provide(request, {signal}) {
    signal.throwIfAborted(); const edits = [];
    if (request.formatOptions.trimTrailingWhitespace) request.snapshot.text.split(/\r\n|\r|\n/).forEach((line, number) => {
      const trailing = line.match(/[ \t]+$/); if (!trailing) return;
      const range = {start: {line: number, character: trailing.index}, end: {line: number, character: line.length}};
      if (request.range && (compare(range.start, request.range.start) < 0 || compare(range.end, request.range.end) > 0)) return;
      edits.push({range, text: ''});
    });
    return createLanguageResult(request, edits.length ? await editPlan(request, edits, 'Trim trailing whitespace') : null);
  }};
  context.registerLanguageProvider('format-document', {languages: ['teaching']}, formatter);
  context.registerLanguageProvider('format-range', {languages: ['teaching']}, formatter);
  context.registerLanguageProvider('code-actions', {languages: ['teaching']}, {
    provide(request, {signal}) {
      signal.throwIfAborted();
      if (request.context.only && !request.context.only.includes('quickfix')) return createLanguageResult(request, []);
      return createLanguageResult(request, request.diagnosticContext.diagnostics.map((diagnostic, index) => ({title: 'Replace TODO with DONE', kind: 'quickfix', diagnosticIndices: [index], isPreferred: index === 0, resolveData: {index}})));
    },
    async resolve(request, item, {signal}) {
      signal.throwIfAborted(); const diagnostic = request.diagnosticContext.diagnostics[item.resolveData.index];
      return {...item, edit: await editPlan(request, [{range: diagnostic.range, text: 'DONE'}], 'Apply the selected TODO fix')};
    },
  });
});
