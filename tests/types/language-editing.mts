import {createPluginHost, createLanguageRegistry, createLanguageResult, parseCodeAction, parseFormattingOptions, type CodeAction, type FormattingOptions} from '@altifigence/dds-plugin-sdk';
import type {WorkspaceEdit} from '@altifigence/dds-plugin-sdk/workspace-edits';
const host = createPluginHost();
const options: FormattingOptions = parseFormattingOptions({tabSize: 2, insertSpaces: true});
const range = {start: {line: 0, character: 0}, end: {line: 0, character: 4}};
const formatted = await host.requestLanguage('format-document', {path: 'main.txt', formatOptions: options});
const edit: WorkspaceEdit | null = host.prepareFormatting(formatted);
await host.requestLanguage('format-range', {path: 'main.txt', range, formatOptions: options});
const actions = await host.requestLanguage('code-actions', {path: 'main.txt', range, context: {triggerKind: 'invoked', only: ['quickfix']}});
const resolved = await host.resolveCodeAction(actions.data[0]!.resolveToken!);
const fix: WorkspaceEdit = host.prepareCodeAction(resolved); host.releaseCodeActions(actions);
const registry = createLanguageRegistry('code-actions');
registry.register('typed', {languages: ['plain']}, {
  provide(request) {const diagnosticRevision: number = request.diagnosticContext.revision; void diagnosticRevision; return createLanguageResult(request, [{title: 'Fix', kind: 'quickfix', resolveData: {id: 1}}]);},
  resolve(_request, selected) {const action: CodeAction = selected; return {...action, edit: fix};},
}, {resolve: true});
registry.release(await registry.resolve('host-issued-token'));
parseCodeAction({title: 'Unavailable', kind: 'quickfix', disabled: {reason: 'No fix'}});
// @ts-expect-error Document formatting has no position.
host.requestLanguage('format-document', {path: 'main.txt', formatOptions: options, position: {line: 0, character: 0}});
// @ts-expect-error Range formatting requires a range.
host.requestLanguage('format-range', {path: 'main.txt', formatOptions: options});
// @ts-expect-error Only the host injects the diagnostic bundle.
host.requestLanguage('code-actions', {path: 'main.txt', range, diagnosticContext: {revision: 0, diagnostics: []}});
// @ts-expect-error Executable action kinds are unsupported.
const bad: CodeAction = {title: 'Run shell', kind: 'shell', resolveData: {}};
void edit; void bad;
