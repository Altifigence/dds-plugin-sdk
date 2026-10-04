import {createPluginHost, createLanguageRegistry, createLanguageResult, parseSnippet, parseSignatureHelp, type CompletionInsertion, type CompletionItem} from '@altifigence/dds-plugin-sdk';
const host = createPluginHost({grants: ['document.read', 'language.provide']});
const supported: boolean = host.languageCapabilities().completionResolve;
const signature = await host.requestLanguage('signature-help', {position: {line: 0, character: 0}, context: {triggerKind: 'character', triggerCharacter: '(', isRetrigger: false}});
const active: number | null | undefined = signature.data?.activeParameter;
const completion = await host.requestLanguage('completion', {position: {line: 0, character: 0}, context: {triggerKind: 'incomplete'}});
const resolved = await host.resolveCompletion(completion.data[0]!.resolveToken!);
const preview: CompletionInsertion = host.prepareCompletion(resolved);
const offset: number | undefined = parseSnippet('${1:hello}$0').tabstops[0]?.ranges[0]?.start;
const registry = createLanguageRegistry('completion');
registry.register('typed', {languages: ['teaching']}, {
  provide: request => createLanguageResult(request, [{label: 'sum', insertText: '$0', insertTextFormat: 'snippet', resolveData: {id: 'sum'}}]),
  resolve(_request, selected, {signal}) {signal.throwIfAborted(); return {...selected, documentation: 'plain text'};},
}, {resolve: true, snippets: true});
host.releaseCompletion(completion);
parseSignatureHelp({signatures: [{label: 'run()', parameters: []}], activeSignature: 0, activeParameter: null});
// @ts-expect-error Signature help needs a document position.
host.requestLanguage('signature-help', {});
// @ts-expect-error Completion context does not accept signature retrigger metadata.
host.requestLanguage('completion', {position: {line: 0, character: 0}, context: {triggerKind: 'invoked', isRetrigger: false}});
// @ts-expect-error Hover has no trigger context.
host.requestLanguage('hover', {position: {line: 0, character: 0}, context: {triggerKind: 'invoked'}});
// @ts-expect-error Snippets are a fixed grammar, with no command insertion format.
const executable: CompletionItem = {label: 'wrong', insertText: '', insertTextFormat: 'command'};
// @ts-expect-error Completion previews are immutable.
preview.content = '';
void supported; void active; void offset; void executable;
