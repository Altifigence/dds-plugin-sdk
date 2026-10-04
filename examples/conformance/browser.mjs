import {createPluginHost} from '/sdk/index.mjs';
import {createSettingsStore} from '/sdk/settings.mjs';
import * as localization from '/sdk/localization.mjs';
import * as testing from '/sdk/testing.mjs';
import * as diagnostics from '/sdk/diagnostics.mjs';
import {SDK_VERSION} from '/sdk/version.mjs';
import {runConformance,CONFORMANCE_CASES} from '/sdk/conformance.mjs';
const button=document.querySelector('#run'),status=document.querySelector('#status');
document.querySelector('#theme').addEventListener('change',event=>{document.documentElement.dataset.theme=event.target.checked?'dark':'light';});
button.addEventListener('click',async()=>{
  button.disabled=true;status.textContent='Running synthetic fixtures…';
  try{
    const adapters={host:createPluginHost,settings:createSettingsStore,localization,testing,diagnostics};
    const report=await runConformance({identity:{host:'Browser SDK host',version:SDK_VERSION,runtime:'Browser ESM',platform:'browser'},features:CONFORMANCE_CASES.filter(c=>Object.hasOwn(adapters,c.port)).map(c=>c.id),adapters});
    document.querySelector('#results').replaceChildren(...report.results.map(result=>{const row=document.createElement('tr');for(const key of ['id','status','cleanup']){const cell=document.createElement('td');cell.textContent=result[key];if(key==='status')cell.dataset.status=result.status;row.append(cell);}return row;}));
    const identity=document.querySelector('#identity');identity.replaceChildren(...Object.entries(report.identity).flatMap(([key,value])=>{const term=document.createElement('dt'),definition=document.createElement('dd');term.textContent=key;definition.textContent=value;return [term,definition];}));
    identity.hidden=false;document.querySelector('.table-wrap').hidden=false;
    status.textContent=`${report.ok?'Checks passed':'Checks failed'} · ${report.summary.supported} supported · ${report.summary.unsupported} unsupported · ${report.summary.failed} failed`;
  }catch{status.textContent='Checks could not complete. Review the local host adapter.';}
  finally{button.disabled=false;}
});
