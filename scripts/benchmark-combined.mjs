import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
const samples=[];
for(let n=0;n<5;n++){
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./benchmark-combined-worker.mjs',import.meta.url))],{encoding:'utf8',timeout:60000,maxBuffer:1_000_000,windowsHide:true});
  if(result.error||result.status!==0)throw Error(result.stderr||result.error?.message||'Combined workload failed');samples.push(JSON.parse(result.stdout));
}
const median=list=>[...list].sort((a,b)=>a-b)[Math.floor(list.length/2)],stats=list=>{const m=median(list);return {median:m,mad:median(list.map(v=>Math.abs(v-m))),min:Math.min(...list),max:Math.max(...list)};};
const selected={importMs:s=>s.importMs,elapsedMs:s=>s.elapsedMs,cpuMs:s=>s.cpuMs,peakRssBytes:s=>s.peakRssBytes,peakHeapBytes:s=>s.peakHeapBytes,watchLatencyMs:s=>Math.max(...s.watchLatencyMs),hostStartMs:s=>Math.max(...s.hostStartMs),requestBytes:s=>s.requestBytes,responseBytes:s=>s.responseBytes,diskReadBytes:s=>s.logicalDisk.readBytes,diskWriteBytes:s=>s.logicalDisk.writeBytes,peakHandles:s=>s.logicalDisk.peakHandles};
const measurements=Object.fromEntries(Object.entries(selected).map(([key,select])=>[key,stats(samples.map(select))]));
const profile=`${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`;
let baseline;try{baseline=JSON.parse(await readFile(new URL('../tests/performance-baselines.json',import.meta.url),'utf8')).profiles[profile];}catch(error){if(error.code!=='ENOENT')throw error;}
const failures=[];
if(baseline)for(const [metric,limits] of Object.entries(baseline.metrics)){if(measurements[metric].median>limits.maximumMedian)failures.push(metric);}
const report={schemaVersion:1,profile,runtime:{node:process.version,platform:process.platform,arch:process.arch,osRelease:os.release()},sampleCount:samples.length,fixture:{cycles:3,bytes:131089,languageRequests:120,commands:120,verifiedTransfers:6,watchUpdates:3},measurements,baseline:baseline?{source:baseline.source,failures}:null,logicalDisk:'Instrumented fs.promises payload I/O; excludes physical device/cache behavior.',resourceCleanup:samples.every(s=>s.logicalDisk.remainingHandles===0&&Object.keys(s.remainingResources).length===0)};
console.log(JSON.stringify(report,null,2));
if(failures.length)throw Error('Combined workload regression: '+failures.join(', '));
if(!baseline&&!process.argv.includes('--calibrate'))throw Error('Missing measured baseline for '+profile+'; run explicit calibration and review the result');
