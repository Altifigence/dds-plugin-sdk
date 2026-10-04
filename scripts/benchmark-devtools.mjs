import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createDiagnosticSession} from '../src/diagnostics.mjs';
import {createScenarioHost} from '../src/testing.mjs';
import {definePlugin} from '../src/index.mjs';

const iterations=10000,batches=5,median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];let checksum=0;
const baseline=[],disabled=[],sampled=[],all=[];
for(let batch=0;batch<batches;batch++)for(const [kind,result,options]of [['baseline',baseline,null],['disabled',disabled,{}],['sampled',sampled,{enabled:true,sampleEvery:10}],['all',all,{enabled:true}]]){
  const session=options&&createDiagnosticSession(options),start=performance.now();
  for(let i=0;i<iterations;i++){if(session)session.measure('command',()=>{checksum++;});else checksum++;}
  const elapsed=performance.now()-start;result.push(elapsed);if(session){const report=session.snapshot();assert.ok(report.events.length<=128);assert.equal(report.pending,0);session.dispose();}
}
const manifest={manifestVersion:2,id:'benchmark',name:'Benchmark',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:[],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
for(let i=0;i<100;i++){const scenario=createScenarioHost({seed:i});await scenario.host.activate(definePlugin(manifest,ctx=>ctx.registerCommand({id:'example',title:'Example'},()=>null)));await scenario.host.executeCommand('benchmark','example',{});await scenario.dispose();scenario.assertClean();}
const results={schemaVersion:1,node:process.version,platform:process.platform,iterations,batches,baselineMedianMs:median(baseline),disabledMedianMs:median(disabled),sampleEvery10MedianMs:median(sampled),allEventsMedianMs:median(all),allEventsOverheadUsPerOperation:1000*(median(all)-median(baseline))/iterations,cleanScenarioLifecycles:100,checksum};
console.log(JSON.stringify(results,null,2));
