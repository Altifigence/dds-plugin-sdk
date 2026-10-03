// SPDX-FileCopyrightText: 2026 Altifigence
// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseTheme, serializeThemeXml, THEME_METRICS } from '@altifigence/dds-plugin-sdk/themes';

const html = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

// This is an illustrative preview, not a copied DDS component or theme renderer.
export function renderPreview(input) {
  const theme = parseTheme(input);
  const panels = ['light', 'dark'].map(mode => {
    const palette = theme.colors[mode];
    const tokens = theme.colors.tokens?.[mode] ?? {};
    const roles = {
      ...palette, search: tokens.search ?? palette.tool, searchText: tokens.searchText ?? palette.text,
      searchPlaceholder: tokens.searchPlaceholder ?? palette.muted, selection: tokens.selection ?? palette.navigation,
      selectionText: tokens.selectionText ?? palette.text, tabActive: tokens.tabActive ?? palette.main,
      tabInactive: tokens.tabInactive ?? palette.tool, tabText: tokens.tabText ?? palette.text,
      panelBorder: tokens.panelBorder ?? palette.navigation, focus: tokens.focus ?? palette.text,
      success: tokens.success ?? palette.text, info: tokens.info ?? palette.text,
      hintsBoxBackground: tokens.hintsBoxBackground ?? palette.tool,
      hintsBoxDetailsBackground: tokens.hintsBoxDetailsBackground ?? palette.main,
      hintsBoxText: tokens.hintsBoxText ?? palette.text, hintsBoxDetailsText: tokens.hintsBoxDetailsText ?? palette.text,
      hintsBoxMutedText: tokens.hintsBoxMutedText ?? palette.muted,
      hintsBoxSelectedBackground: tokens.hintsBoxSelectedBackground ?? palette.navigation,
      hintsBoxSelectedText: tokens.hintsBoxSelectedText ?? palette.text,
      gdsBackground: tokens.gdsBackground ?? palette.backdrop,
    };
    const variables = Object.entries(roles).map(([key, value]) => `--${key}:${value}`);
    for (const [key, bounds] of Object.entries(THEME_METRICS)) {
      variables.push(`--${key}:${theme.colors.metrics?.[key] ?? bounds.default}${bounds.integer ? 'px' : ''}`);
    }
    return `<section class="mode" style="${variables.join(';')}" aria-labelledby="${mode}">
      <h2 id="${mode}">${mode === 'light' ? 'Light' : 'Dark'}</h2>
      <div class="workspace">
        <aside><strong>Project</strong><p class="file selected">adder.sv</p><p class="file">testbench.sv</p><p class="file muted">notes.md</p></aside>
        <main><div class="tabs"><span class="active">adder.sv</span><span>testbench.sv</span></div>
          <div class="editor"><label>Search<input placeholder="Search the project" aria-label="Search ${mode} preview"></label>
            <pre><span class="muted">// A saved theme for your workspace</span>
<span class="keyword">module</span> adder;
  logic [7:0] result;
<span class="keyword">endmodule</span></pre>
            <div class="hints"><div class="suggestions"><div class="hint-selected">result</div><div>reset</div><small>HintsBox</small></div><div class="details">result<small>logic [7:0]<br>Suggestion details</small></div></div>
            <div class="canvas" aria-label="GDS canvas sample"><i></i><i></i><small>GDS canvas</small></div>
            <p class="status">✓ Saved XML v2 theme</p>
          </div>
        </main>
      </div>
    </section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'">
<title>${html(theme.name)} — DDS theme preview</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:32px;background:#eef2f5;color:#173346;font:15px/1.5 system-ui,sans-serif}header{max-width:1320px;margin:0 auto 24px}h1{margin:0;font-size:28px}header p{max-width:780px}a{color:#00678e;font-weight:600}h2{margin:0 0 14px;font-size:18px}.previews{max-width:1320px;margin:auto;display:grid;grid-template-columns:1fr 1fr;gap:24px}.mode{padding:20px;background:var(--backdrop);color:var(--text);border-radius:var(--panelRadius)}.workspace{display:grid;grid-template-columns:130px minmax(0,1fr);border-radius:var(--controlRadius);overflow:hidden;border:1px solid var(--panelBorder);min-height:440px}aside{background:var(--navigation);padding:18px 10px}aside strong{padding:0 8px}.file{padding:7px 8px;margin:8px 0;border-radius:var(--controlRadius);font-size:13px}.selected{background:var(--selection);color:var(--selectionText)}main{background:var(--main);min-width:0}.tabs{display:flex;background:var(--tool);color:var(--tabText);font-size:12px}.tabs span{padding:12px 14px;background:var(--tabInactive)}.tabs .active{background:var(--tabActive)}.editor{padding:18px}label{display:block;font-size:12px;color:var(--muted)}input{margin-top:5px;width:100%;border:0;border-radius:var(--controlRadius);padding:10px;background:var(--search);color:var(--searchText);font:inherit}input::placeholder{color:var(--searchPlaceholder)}input:focus-visible{outline:2px solid var(--focus);outline-offset:2px}pre{margin:20px 0;font:12px/1.8 ui-monospace,monospace;white-space:pre-wrap}.muted{color:var(--muted)}.keyword{color:var(--info)}.hints{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--panelBorder);border-radius:var(--popoverRadius);overflow:hidden}.suggestions{padding:8px;background:var(--hintsBoxBackground);color:var(--hintsBoxText)}.suggestions div{padding:4px 8px}.hint-selected{background:var(--hintsBoxSelectedBackground);color:var(--hintsBoxSelectedText);border-radius:var(--controlRadius)}small{display:block;margin-top:8px;color:var(--hintsBoxMutedText);font-size:11px}.details{padding:12px;background:var(--hintsBoxDetailsBackground);color:var(--hintsBoxDetailsText)}.canvas{position:relative;height:70px;margin-top:16px;background:var(--gdsBackground);border-radius:var(--controlRadius);overflow:hidden}.canvas i{position:absolute;width:85px;height:32px;top:14px;left:20px;background:var(--info);opacity:.65}.canvas i+i{left:65px;top:28px;background:var(--success)}.canvas small{position:absolute;right:8px;bottom:4px;color:var(--muted)}.status{margin:14px 0 0;color:var(--success);font-size:12px}footer{max-width:1320px;margin:24px auto;color:#486477;font-size:13px}@media(max-width:1000px){.previews{grid-template-columns:1fr}}@media(max-width:480px){body{padding:16px}.mode{padding:14px}.workspace{grid-template-columns:1fr}aside{display:none}.editor{padding:12px}.tabs span{padding:10px}.hints{grid-template-columns:1fr}.details{display:none}}
</style></head><body><header><h1>${html(theme.name)}</h1><p>A palette example for Digital Design Studio. Compare light and dark modes, search, editor tabs, HintsBox and the GDS canvas.</p><a href="hello-theme.xml" download>Download the XML theme</a></header><div class="previews">${panels}</div><footer>Illustrative preview. DDS applies the same named color data using its own components, accessibility settings and token defaults. To use it, install the XML in Plugins and choose Apply, or import it in Settings → Appearance.</footer></body></html>
`;
}

export async function exportExample() {
  const theme = parseTheme(await readFile(new URL('./theme.json', import.meta.url), 'utf8'));
  const xml = serializeThemeXml(theme);
  await writeFile(new URL('./hello-theme.xml', import.meta.url), xml);
  await writeFile(new URL('./preview.html', import.meta.url), renderPreview(theme));
  console.log(`Exported ${theme.name}: hello-theme.xml (${new TextEncoder().encode(xml).byteLength} UTF-8 bytes) and preview.html`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await exportExample();
