import {SDK_VERSION} from './version.mjs';
import {configurationCopy,configurationObject as object,configurationInteger as integer,freezeConfiguration} from './configuration-values.mjs';
import {CONFORMANCE_CASES,CONFORMANCE_FEATURES} from './conformance-catalog.mjs';
import {HOST_CASES} from './conformance-host.mjs';
import {WORKSPACE_CASES} from './conformance-workspace.mjs';
import {DEVELOPMENT_CASES} from './conformance-development.mjs';
export {CONFORMANCE_CASES,CONFORMANCE_FEATURES} from './conformance-catalog.mjs';

export const CONFORMANCE_LIMITS=Object.freeze({features:64,timeoutMs:30000,reportBytes:65536});
const implementations={...HOST_CASES,...WORKSPACE_CASES,...DEVELOPMENT_CASES};
const reasons=['passed','not_declared','missing_adapter','assertion','provider_error','timed_out','cancelled','cleanup_failed','aborted_after_timeout'];
function invalid(){throw new TypeError('Invalid conformance contract');}
function token(value,max=128){if(typeof value!=='string'||value.length>max||!/^[A-Za-z0-9][A-Za-z0-9 ._+()-]*$/.test(value))invalid();return value;}
function featureList(value){if(!Array.isArray(value)||value.length>64||new Set(value).size!==value.length)invalid();return value.map(v=>token(v));}
function identity(value){const v=configurationCopy(value);object(v,['host','version','runtime','platform']);for(const field of Object.keys(v))token(v[field]);return v;}
function count(results,status){return results.filter(value=>value.status===status).length;}

/** Strict, payload-free report readback. This report describes test evidence, not certification. */
export function parseConformanceReport(input){
  const v=configurationCopy(input,CONFORMANCE_LIMITS.reportBytes);
  object(v,['schemaVersion','suiteVersion','sdkVersion','identity','declaredFeatures','unknownFeatures','requiredFeatures','results','summary','ok']);
  if(v.schemaVersion!==1||v.suiteVersion!==1)invalid();token(v.sdkVersion);identity(v.identity);
  featureList(v.declaredFeatures);featureList(v.unknownFeatures);featureList(v.requiredFeatures);
  if(v.requiredFeatures.some(f=>!CONFORMANCE_FEATURES.includes(f))||JSON.stringify(v.unknownFeatures)!==JSON.stringify(v.declaredFeatures.filter(f=>!CONFORMANCE_FEATURES.includes(f))))invalid();
  if(!Array.isArray(v.results)||v.results.length!==CONFORMANCE_CASES.length)invalid();
  for(let i=0;i<v.results.length;i++){
    const r=v.results[i];object(r,['id','status','reason','check','durationMs','cleanup']);
    if(r.id!==CONFORMANCE_CASES[i].id||!['supported','unsupported','failed'].includes(r.status)||!reasons.includes(r.reason)||!['complete','pending','failed','not-run'].includes(r.cleanup))invalid();
    if(r.check!==null)token(r.check);
    if(typeof r.durationMs!=='number'||!Number.isFinite(r.durationMs)||r.durationMs<0)invalid();
    if(r.status==='supported'&&(r.reason!=='passed'||r.cleanup!=='complete'||r.check!==null)||r.status==='unsupported'&&(r.reason!=='not_declared'||v.declaredFeatures.includes(r.id)||v.requiredFeatures.includes(r.id)))invalid();
    if(r.status==='failed'&&['passed','not_declared'].includes(r.reason))invalid();
  }
  object(v.summary,['supported','unsupported','failed']);
  for(const status of ['supported','unsupported','failed'])if(v.summary[status]!==count(v.results,status))invalid();
  const ok=v.summary.failed===0&&v.requiredFeatures.every(id=>v.results.find(r=>r.id===id)?.status==='supported');
  if(v.ok!==ok)invalid();return v;
}

/** Adapters execute trusted local fixture code. A deadline cannot interrupt synchronous code. */
export async function runConformance(options){
  object(options,['identity','features','adapters'],['requiredFeatures','timeoutMs','signal']);
  const selectedIdentity=identity(options.identity),declared=featureList(options.features),required=featureList(options.requiredFeatures??CONFORMANCE_CASES.filter(c=>c.required).map(c=>c.id));
  if(required.some(f=>!CONFORMANCE_FEATURES.includes(f)))invalid();
  const timeoutMs=options.timeoutMs??10000;integer(timeoutMs,CONFORMANCE_LIMITS.timeoutMs,1);
  if(!options.adapters||typeof options.adapters!=='object'||options.signal!==undefined&&!(options.signal instanceof AbortSignal))invalid();
  const results=[];let stop=false;
  for(const spec of CONFORMANCE_CASES){
    const start=performance.now(),cleanups=[],late=[];let closed=false,reason='passed',check=null,cleanup='complete',timer,aborted;
    const finish=(status,why,cleanupState='not-run')=>results.push({id:spec.id,status,reason:why,check:null,durationMs:0,cleanup:cleanupState});
    if(!declared.includes(spec.id)&&!required.includes(spec.id)){finish('unsupported','not_declared');continue;}
    if(stop||options.signal?.aborted){finish('failed',options.signal?.aborted?'cancelled':'aborted_after_timeout');continue;}
    if(!options.adapters[spec.port]||(spec.id==='diagnostics'&&!options.adapters.host)){finish('failed','missing_adapter');continue;}
    const controller=new AbortController();
    const own=fn=>{if(typeof fn!=='function')invalid();if(closed){const work=Promise.resolve().then(fn);work.catch(()=>{});late.push(work);}else cleanups.push(fn);};
    const work=Promise.resolve().then(()=>implementations[spec.id]({adapters:options.adapters,signal:controller.signal,own}));
    // The operation is always observed, including late rejection after a deadline.
    const result=work.then(()=>({reason:'passed'}),error=>({reason:typeof error?.check==='string'?'assertion':'provider_error',check:typeof error?.check==='string'&&/^[a-z_]+$/.test(error.check)?error.check:null}));
    try{
      const deadline=new Promise(resolve=>{timer=setTimeout(()=>resolve({reason:'timed_out'}),timeoutMs);aborted=()=>resolve({reason:'cancelled'});options.signal?.addEventListener('abort',aborted,{once:true});if(options.signal?.aborted)aborted();});
      const outcome=await Promise.race([result,deadline]);reason=outcome.reason;check=outcome.check??null;
      if(['timed_out','cancelled'].includes(reason)){controller.abort();stop=true;cleanup='pending';}
    }finally{
      clearTimeout(timer);options.signal?.removeEventListener('abort',aborted);closed=true;controller.abort();
      // A broken adapter must not prevent a bounded report or retain an unobserved rejection.
      for(const fn of cleanups.reverse()){
        let cleanupTimer;
        const pending=Promise.resolve().then(fn).then(()=>true,()=>false);
        const outcome=await Promise.race([pending,new Promise(resolve=>{cleanupTimer=setTimeout(()=>resolve(null),Math.min(timeoutMs,1000));})]);
        clearTimeout(cleanupTimer);
        if(outcome===false){cleanup='failed';reason='cleanup_failed';}else if(outcome===null){cleanup='pending';reason='cleanup_failed';stop=true;}
      }
      // Late-created resources register with `own` and are disposed when they arrive.
      result.then(async()=>{await Promise.allSettled(late);}).catch(()=>{});
    }
    results.push({id:spec.id,status:reason==='passed'?'supported':'failed',reason,check,durationMs:Math.max(0,Math.round((performance.now()-start)*1000)/1000),cleanup});
  }
  const summary=Object.fromEntries(['supported','unsupported','failed'].map(status=>[status,count(results,status)]));
  return parseConformanceReport({schemaVersion:1,suiteVersion:1,sdkVersion:SDK_VERSION,identity:selectedIdentity,declaredFeatures:declared,unknownFeatures:declared.filter(f=>!CONFORMANCE_FEATURES.includes(f)),requiredFeatures:required,results,summary,ok:summary.failed===0&&required.every(id=>results.find(r=>r.id===id)?.status==='supported')});
}
export function formatConformanceReport(input){
  const r=parseConformanceReport(input),i=r.identity;
  return [`DDS Plugin SDK conformance v${r.suiteVersion} (${r.sdkVersion})`,`${i.host} ${i.version} | ${i.runtime} | ${i.platform}`,`${r.ok?'PASS':'FAIL'}: ${r.summary.supported} supported, ${r.summary.unsupported} unsupported, ${r.summary.failed} failed`,...r.results.map(v=>`${v.status.padEnd(11)} ${v.id}: ${v.reason}${v.check?` (${v.check})`:''}; cleanup=${v.cleanup}`),...(r.unknownFeatures.length?[`Unknown declarations (not probed): ${r.unknownFeatures.join(', ')}`]:[])].join('\n');
}
