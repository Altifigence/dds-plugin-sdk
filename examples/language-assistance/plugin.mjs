import {definePlugin, createLanguageResult} from '@altifigence/dds-plugin-sdk';

// Teaching grammar: identifiers, decimal numbers, nested calls and commas.
// Real language plugins should obtain this context from their own parser.
function activeCall(text, position) {
  const lines = text.split(/\r\n|\r|\n/);
  const prefix = [...lines.slice(0, position.line), lines[position.line].slice(0, position.character)].join('\n');
  const calls = [];
  for (const token of prefix.matchAll(/[A-Za-z_]+\s*\(|[(),]/g)) {
    if (token[0].endsWith('(')) calls.push({name: token[0].slice(0, -1).trim(), parameter: 0});
    else if (token[0] === ')') calls.pop();
    else if (calls.length) calls.at(-1).parameter++;
  }
  return calls.at(-1);
}

export default definePlugin({
  manifestVersion: 2, id: 'teaching-assistance', name: 'Teaching Assistance', publisher: 'example', version: '1.0.0',
  protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', license: 'Apache-2.0',
  source: {visibility: 'open', licenseFile: 'LICENSE'}, supportedHosts: ['test-host'],
  capabilities: ['signature-help', 'completion', 'completion-resolve', 'completion-snippets'],
  permissions: ['document.read', 'language.provide'],
}, context => {
  context.registerLanguageProvider('signature-help', {languages: ['teaching']}, {
    provide(request, {signal}) {
      signal.throwIfAborted();
      const call = activeCall(request.snapshot.text, request.position);
      if (!call || !['sum', 'scale'].includes(call.name)) return createLanguageResult(request, null);
      const label = call.name + '(left, right)';
      const start = call.name.length + 1;
      return createLanguageResult(request, {
        signatures: [
          {label, parameters: [{label: [start, start + 4]}, {label: [start + 6, start + 11]}], documentation: 'Combine two numbers.'},
          {label: call.name + '(values)', parameters: [{label: [start, start + 6]}], documentation: 'Combine a list of numbers.'},
        ], activeSignature: 0, activeParameter: Math.min(call.parameter, 1),
      });
    },
  });
  context.registerLanguageProvider('completion', {languages: ['teaching']}, {
    provide(request, {signal}) {
      signal.throwIfAborted();
      const prefix = request.snapshot.text.split(/\r\n|\r|\n/)[request.position.line].slice(0, request.position.character).match(/[A-Za-z_]*$/)[0];
      return createLanguageResult(request, [{
        label: 'sum', insertText: 'sum(${1:left}, ${2:right})$0', insertTextFormat: 'snippet',
        range: {start: {...request.position, character: request.position.character - prefix.length}, end: request.position},
        resolveData: {symbol: 'sum'},
      }]);
    },
    async resolve(_request, item, {signal}) {
      signal.throwIfAborted();
      // Lookup happens only after the caller selects this item. No I/O is needed here.
      return {...item, detail: 'sum(left, right)', documentation: 'Adds two numbers. This is plain text.'};
    },
  });
});
