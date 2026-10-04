import {createPluginHost, decodeSemanticTokens, SEMANTIC_STYLE_KEYS} from '@altifigence/dds-plugin-sdk';
import {createTeachingDisplayPlugin, sample} from './plugin.mjs';
const byId = id => document.getElementById(id), counters = {full: 0, delta: 0};
const host = createPluginHost({grants: ['document.read', 'language.provide']}), plugin = createTeachingDisplayPlugin(counters);
let activation = await host.activate(plugin), semantic, stale = 0, active = true;
let model = {uri: 'memory:///counter', languageId: 'teaching', modelVersion: 1, workspaceRevision: 'one', text: sample};
host.setDocument(model);
function status(message) {byId('status').textContent = message; byId('metrics').textContent = `Version ${model.modelVersion} · Full calls ${counters.full} · Delta calls ${counters.delta} · Stale results discarded ${stale}`;}
function paint(results) {
  for (const result of results) host.validateLanguageResult(result);
  const [tokens, folds, hints, symbols] = results, decoded = decodeSemanticTokens(tokens.data, model.text), editor = byId('editor');
  editor.replaceChildren(); byId('outline').replaceChildren();
  const rows = model.text.split(/\r\n|\r|\n/).map((text, line) => {
    const row = document.createElement('div'); row.className = 'line'; row.tabIndex = -1; row.dataset.line = String(line);
    const number = document.createElement('span'); number.className = 'number'; number.textContent = String(line + 1); row.append(number);
    const fold = folds.data.find(item => item.range.start.line === line), gutter = document.createElement(fold ? 'button' : 'span');
    gutter.className = fold ? 'fold' : 'gutter';
    if (fold) {
      gutter.textContent = '▾'; gutter.setAttribute('aria-label', `Fold line ${line + 1}`); gutter.setAttribute('aria-expanded', 'true');
      gutter.addEventListener('click', () => {const open = gutter.getAttribute('aria-expanded') === 'true'; gutter.setAttribute('aria-expanded', String(!open)); gutter.textContent = open ? '▸' : '▾'; for (let n = line + 1; n < fold.range.end.line; n++) rows[n].hidden = open;});
    }
    row.append(gutter); let offset = 0;
    const lineHints = hints.data.filter(hint => hint.position.line === line), boundaries = new Set([0, text.length]);
    const lineTokens = decoded.filter(token => token.range.start.line === line);
    for (const token of lineTokens) {boundaries.add(token.range.start.character); boundaries.add(token.range.end.character);}
    for (const hint of lineHints) boundaries.add(hint.position.character);
    for (const boundary of [...boundaries].sort((a, b) => a - b)) {
      if (boundary > offset) {
        const span = document.createElement('span'), token = lineTokens.find(token => token.range.start.character <= offset && token.range.end.character >= boundary);
        const style = token && SEMANTIC_STYLE_KEYS.includes(token.style) ? token.style : 'plain'; span.className = style === 'number' ? 'number-token' : style;
        span.textContent = text.slice(offset, boundary); row.append(span);
      }
      for (const hint of lineHints.filter(hint => hint.position.character === boundary)) {const span = document.createElement('span'); span.className = 'hint'; span.textContent = hint.label; span.title = hint.tooltip ?? ''; row.append(span);}
      offset = boundary;
    }
    editor.append(row); return row;
  });
  function tree(items, parent) {
    const list = document.createElement('ul'); parent.append(list);
    for (const item of items) {const row = document.createElement('li'), button = document.createElement('button'); button.textContent = `${item.name} · ${item.kind}`; button.addEventListener('click', () => {const target = rows[item.selectionRange.start.line]; target.hidden = false; target.focus();}); row.append(button); list.append(row); if (item.children?.length) tree(item.children, row);}
  }
  tree(symbols.data, byId('outline')); semantic = tokens;
}
async function refresh(previousResultId) {
  const lines = model.text.split(/\r\n|\r|\n/), end = {line: lines.length - 1, character: lines.at(-1).length};
  const results = await Promise.all([host.requestLanguage('semantic-tokens', previousResultId ? {previousResultId} : {}), host.requestLanguage('folding-ranges', {}), host.requestLanguage('inlay-hints', {range: {start: {line: 0, character: 0}, end}}), host.requestLanguage('document-symbol-tree', {})]);
  paint(results); status(`Rendered ${semantic.data.updateKind} result. Provider active.`);
}
function discardPrevious() {if (!semantic) return; try {host.validateLanguageResult(semantic);} catch (error) {if (!['stale_snapshot', 'disposed'].includes(error.code)) throw error; stale++;}}
async function perform(action) {
  for (const button of document.querySelectorAll('.toolbar button')) button.disabled = true;
  try {await action();} catch (error) {status(`Request stopped: ${error.code ?? 'unavailable'}`);} finally {for (const button of document.querySelectorAll('.toolbar button')) button.disabled = false; byId('deactivate').disabled = !active; byId('restart').disabled = active;}
}
byId('full').addEventListener('click', () => perform(() => refresh()));
byId('edit').addEventListener('click', () => perform(async () => {const previous = semantic?.data.resultId; model = {...model, modelVersion: model.modelVersion + 1, text: model.text.includes('12345') ? model.text.replace('12345', '12') : model.text.replace('12', '12345')}; host.setDocument(model); discardPrevious(); await refresh(previous);}));
byId('fallback').addEventListener('click', () => perform(async () => {const previous = semantic?.data.resultId; if (semantic) host.releaseLanguageResult(semantic); await refresh(previous);}));
byId('deactivate').addEventListener('click', () => perform(() => {activation.dispose(); active = false; discardPrevious(); byId('editor').replaceChildren(); byId('outline').replaceChildren(); status('Provider deactivated. Display results discarded.');}));
byId('restart').addEventListener('click', () => perform(async () => {activation = await host.activate(plugin); active = true; await refresh(semantic?.data.resultId);}));
window.addEventListener('pagehide', () => host.dispose(), {once: true});
await perform(() => refresh());
