import {definePlugin, createLanguageResult} from '@altifigence/dds-plugin-sdk';

const features = ['completion', 'hover', 'definition', 'references', 'document-symbols'];
const manifest = {
  manifestVersion: 2, id: 'hello-language', name: 'Hello Language', publisher: 'example', version: '1.0.0',
  protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', capabilities: features,
  permissions: ['document.read', 'language.provide'], supportedHosts: ['test-host'], license: 'Apache-2.0',
  source: {visibility: 'open', licenseFile: 'LICENSE'},
};

// A tiny single-file teaching language: `let name = value`. This is not an HDL parser.
function analyze(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const declarations = [];
  const occurrences = [];
  lines.forEach((line, number) => {
    const declaration = /^\s*let\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
    for (const token of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (token[0] === 'let') continue;
      const range = {start: {line: number, character: token.index}, end: {line: number, character: token.index + token[0].length}};
      const isDeclaration = !!declaration && token[0] === declaration[1] && token.index === declaration[0].length - declaration[1].length;
      const occurrence = {name: token[0], range, isDeclaration};
      occurrences.push(occurrence);
      if (isDeclaration) declarations.push(occurrence);
    }
  });
  return {declarations, occurrences};
}

export default definePlugin(manifest, context => {
  for (const kind of features) context.registerLanguageProvider(kind, {languages: ['dds-demo']}, {
    provide(request, {signal}) {
      signal.throwIfAborted();
      const {declarations, occurrences} = analyze(request.snapshot.text);
      const current = request.position && occurrences.find(item => item.range.start.line === request.position.line && item.range.start.character <= request.position.character && request.position.character < item.range.end.character);
      let data;
      if (kind === 'completion') data = declarations.map(item => ({label: item.name, insertText: item.name, detail: 'Local declaration'}));
      else if (kind === 'hover') data = current ? {text: `Local name: ${current.name}`, range: current.range} : null;
      else if (kind === 'document-symbols') data = declarations.map(item => ({name: item.name, kind: 'variable', range: item.range, selectionRange: item.range}));
      else {
        const candidates = kind === 'definition' ? declarations : occurrences.filter(item => request.includeDeclaration || !item.isDeclaration);
        data = candidates.filter(item => item.name === current?.name).map(item => ({path: 'demo.dds', range: item.range}));
      }
      return createLanguageResult(request, data);
    },
  });
});
