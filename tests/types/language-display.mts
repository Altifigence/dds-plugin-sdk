import {createPluginHost, createLanguageRegistry, createLanguageResult, definePlugin, decodeSemanticTokens, applySemanticTokensDelta, parseDocumentSymbolTree, LANGUAGE_DISPLAY_LIMITS, type SemanticTokens, type SemanticTokensDelta, type PreviousSemanticTokens, type LanguageResult, type LanguageProvider} from '@altifigence/dds-plugin-sdk';
const host = createPluginHost({grants: ['document.read', 'language.provide']});
const provider: LanguageProvider<'semantic-tokens'> = {
  provide(request) {return createLanguageResult(request, {resultId: 'provider', legend: {tokenTypes: [{name: 'keyword', style: 'keyword'}], tokenModifiers: []}, data: [0, 0, 3, 0, 0]});},
  provideDelta(request, previous: PreviousSemanticTokens, {signal}) {
    signal.throwIfAborted(); const version: number = previous.snapshot.modelVersion;
    // @ts-expect-error Cached previous snapshots do not retain document text.
    previous.snapshot.text;
    return {baseResultId: previous.resultId, resultId: String(version), edits: [{start: 2, deleteCount: 1, data: [2]}]};
  },
};
const registry = createLanguageRegistry('semantic-tokens');
registry.register('display', {languages: ['teaching']}, provider, {semanticDelta: true});
registry.invalidate({retainSemantic: true});
const semantic = await host.requestLanguage('semantic-tokens', {previousResultId: 'host-handle'});
const accepted: LanguageResult<'semantic-tokens'> = host.validateLanguageResult<'semantic-tokens'>(semantic);
decodeSemanticTokens(accepted.data, 'let value'); host.releaseLanguageResult(semantic);
await host.requestLanguage('inlay-hints', {range: {start: {line: 0, character: 0}, end: {line: 0, character: 3}}});
await host.requestLanguage('folding-ranges', {}); await host.requestLanguage('document-symbol-tree', {});
// @ts-expect-error Semantic requests do not take cursor positions.
await host.requestLanguage('semantic-tokens', {position: {line: 0, character: 0}});
// @ts-expect-error Inlay hints require a visible range.
await host.requestLanguage('inlay-hints', {});
// @ts-expect-error Only semantic token providers can supply deltas.
const invalid: LanguageProvider<'folding-ranges'> = {provide: request => createLanguageResult(request, []), provideDelta() {return null;}};
const parsed = parseDocumentSymbolTree([]); const count: number = LANGUAGE_DISPLAY_LIMITS.symbols;
const delta: SemanticTokensDelta = {baseResultId: 'old', resultId: 'new', edits: []};
const tokens: SemanticTokens = applySemanticTokensDelta(semantic.data, delta, 'let value');
void definePlugin; void parsed; void count; void tokens; void invalid;
