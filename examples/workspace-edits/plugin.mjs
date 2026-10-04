import {definePlugin, createLanguageResult} from '@altifigence/dds-plugin-sdk';

function symbolAt(request) {
  const line = request.snapshot.text.split(/\r\n|\r|\n/)[request.position.line];
  for (const match of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (match.index <= request.position.character && request.position.character <= match.index + match[0].length) {
    return {placeholder: match[0], range: {start: {line: request.position.line, character: match.index}, end: {line: request.position.line, character: match.index + match[0].length}}};
  }
  return null;
}

// The caller explicitly reads and supplies these allowed file snapshots. The
// provider itself only proposes edits; it receives no write or journal port.
export function teachingRenamePlugin(files) {
  return definePlugin({
    manifestVersion: 2, id: 'teaching-rename', name: 'Teaching Rename', publisher: 'example', version: '1.0.0',
    protocolVersion: 1, entry: './plugin.mjs', runtime: 'ui', supportedHosts: ['test-host'],
    capabilities: ['prepare-rename', 'rename'], permissions: ['document.read', 'language.provide'],
    license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'},
  }, context => {
    context.registerLanguageProvider('prepare-rename', {languages: ['teaching']}, {provide: request => createLanguageResult(request, symbolAt(request))});
    context.registerLanguageProvider('rename', {languages: ['teaching']}, {provide(request, {signal}) {
      signal.throwIfAborted();
      const symbol = symbolAt(request);
      if (!symbol || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(request.newName)) return createLanguageResult(request, null);
      const changes = [];
      for (const file of files) {
        const edits = [];
        file.content.split(/\r\n|\r|\n/).forEach((line, number) => {
          for (const match of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) if (match[0] === symbol.placeholder) edits.push({range: {start: {line: number, character: match.index}, end: {line: number, character: match.index + match[0].length}}, text: request.newName});
        });
        if (edits.length) changes.push({kind: 'edit', path: file.path, baseRevision: file.revision, edits, reason: 'Rename the selected teaching-language symbol'});
      }
      return createLanguageResult(request, changes.length ? {formatVersion: 1, id: crypto.randomUUID(), title: `Rename ${symbol.placeholder} to ${request.newName}`, changes} : null);
    }});
  });
}
