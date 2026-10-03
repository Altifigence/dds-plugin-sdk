import {createPluginHost, createLanguageRegistry, createLanguageResult, type LanguageRequest} from '@altifigence/dds-plugin-sdk';
const host = createPluginHost({grants: ['document.read', 'language.provide']});
const completion = await host.requestLanguage('completion', {position: {line: 0, character: 0}});
const insert: string | undefined = completion.data[0]?.insertText;
const hover = await host.requestLanguage('hover', {position: {line: 0, character: 0}});
const text: string | undefined = hover.data?.text;
await host.requestLanguage('references', {position: {line: 0, character: 0}, includeDeclaration: true});
await host.requestLanguage('document-symbols', {});
const registry = createLanguageRegistry('hover');
registry.register('example', {languages: ['plaintext']}, {provide(request) {
  const typed: LanguageRequest<'hover'> = request;
  return createLanguageResult(typed, {text: 'plain text'});
}});
// @ts-expect-error A position is required for completion.
host.requestLanguage('completion', {});
// @ts-expect-error Document symbols have no position.
host.requestLanguage('document-symbols', {position: {line: 0, character: 0}});
// @ts-expect-error Only references accepts includeDeclaration.
host.requestLanguage('hover', {position: {line: 0, character: 0}, includeDeclaration: true});
// @ts-expect-error A hover provider cannot return completion items.
registry.register('bad', {languages: ['plaintext']}, {provide: request => createLanguageResult(request, [{label: 'x', insertText: 'x'}])});
void insert; void text;
