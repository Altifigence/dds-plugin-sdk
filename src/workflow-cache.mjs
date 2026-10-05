import {SDK_VERSION} from './version.mjs';
import {parseWorkspacePath} from './contracts.mjs';
import {canonical,clone,digest,fail,fields,sha,identifier,integer,scope,strings,immutable,jsonCopy,aborted,deadline,interruptible,authorized} from './workflow-internals.mjs';

export const WORKFLOW_CACHE_LIMITS=Object.freeze({entries:512,bytes:16_777_216,valueBytes:65_536,files:64,fileBytes:4_194_304,inputBytes:16_777_216,ttlMs:86_400_000,concurrentFills:8,fillTimeoutMs:60_000});
const hasReference=v=>!!v&&typeof v==='object'&&(v.kind==='dds-secret-reference'||Object.values(v).some(hasReference));
export function fingerprintWorkflowInputs(input) {
  fields(input,['scope','commandId','pluginSha256','toolSha256','schema','settings','environment','input','files','grants','policy']);
  scope(input.scope);identifier(input.commandId);sha(input.pluginSha256);if(input.toolSha256!==null)sha(input.toolSha256);strings(input.grants);
  fields(input.policy,['optIn','deterministic','declaredInputsComplete','secretDependent']);if(Object.values(input.policy).some(v=>typeof v!=='boolean'))fail('INVALID','Cache policy must be explicit');
  fields(input.environment,['declared','values']);strings(input.environment.declared);
  const values=jsonCopy(input.environment.values,16_384);if(!values||typeof values!=='object'||Array.isArray(values)||Object.values(values).some(v=>typeof v!=='string'))fail('INVALID','Environment must contain declared string values');
  if(!Array.isArray(input.files)||input.files.length>WORKFLOW_CACHE_LIMITS.files)fail('LIMIT','Fingerprint file limit');
  let total=0;const seen=new Set();
  const files=input.files.map(file=>{
    fields(file,['path','bytes']);parseWorkspacePath(file.path);if(seen.has(file.path.toLowerCase()))fail('INVALID','Duplicate fingerprint path');seen.add(file.path.toLowerCase());
    if(!(file.bytes instanceof Uint8Array)||file.bytes.byteLength>WORKFLOW_CACHE_LIMITS.fileBytes)fail('LIMIT','Fingerprint file budget');
    const bytes=Buffer.from(file.bytes);total+=bytes.length;if(total>WORKFLOW_CACHE_LIMITS.inputBytes)fail('LIMIT','Fingerprint input budget');
    return {path:file.path,byteLength:bytes.length,sha256:digest(bytes)};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const payload=jsonCopy({schema:input.schema,settings:input.settings,input:input.input}),reasons=[];
  if(!input.policy.optIn)reasons.push('not-opted-in');if(!input.policy.deterministic)reasons.push('non-deterministic');if(!input.policy.declaredInputsComplete)reasons.push('unknown-inputs');
  if(input.policy.secretDependent||hasReference(payload))reasons.push('secret-dependent');
  if(Object.keys(values).some(k=>!input.environment.declared.includes(k)))reasons.push('undeclared-environment');
  if(input.environment.declared.some(k=>!Object.hasOwn(values,k)))reasons.push('missing-environment');
  const descriptor={schemaVersion:1,sdkVersion:SDK_VERSION,scope:clone(input.scope),commandId:input.commandId,pluginSha256:input.pluginSha256,toolSha256:input.toolSha256,schemaSha256:digest(canonical(payload.schema)),settingsSha256:digest(canonical(payload.settings)),inputSha256:digest(canonical(payload.input)),environmentSha256:digest(canonical({declared:[...input.environment.declared].sort(),values})),files,grants:[...input.grants].sort(),policy:clone(input.policy)};
  return immutable({schemaVersion:1,key:digest(canonical(descriptor)),eligible:reasons.length===0,reasons,descriptor});
}
export function parseWorkflowFingerprint(input) {
  const value=jsonCopy(input,65_536);fields(value,['schemaVersion','key','eligible','reasons','descriptor']);sha(value.key);
  const d=value.descriptor;fields(d,['schemaVersion','sdkVersion','scope','commandId','pluginSha256','toolSha256','schemaSha256','settingsSha256','inputSha256','environmentSha256','files','grants','policy']);scope(d.scope);identifier(d.commandId);strings(d.grants);strings(value.reasons,8);
  if(value.schemaVersion!==1||d.schemaVersion!==1||typeof value.eligible!=='boolean'||value.eligible!==(value.reasons.length===0)||value.key!==digest(canonical(d)))fail('INVALID','Fingerprint mismatch');
  for(const k of ['pluginSha256','schemaSha256','settingsSha256','inputSha256','environmentSha256'])sha(d[k]);if(d.toolSha256!==null)sha(d.toolSha256);
  if(d.sdkVersion!==SDK_VERSION||!Array.isArray(d.files)||d.files.length>64)fail('INVALID','Unsupported fingerprint');
  fields(d.policy,['optIn','deterministic','declaredInputsComplete','secretDependent']);if(Object.values(d.policy).some(x=>typeof x!=='boolean'))fail('INVALID','Invalid cache policy');
  if(value.eligible&&(!d.policy.optIn||!d.policy.deterministic||!d.policy.declaredInputsComplete||d.policy.secretDependent))fail('INVALID','Ineligible cache policy');
  const seen=new Set();for(const f of d.files){fields(f,['path','byteLength','sha256']);parseWorkspacePath(f.path);sha(f.sha256);integer(f.byteLength,0,WORKFLOW_CACHE_LIMITS.fileBytes);if(seen.has(f.path.toLowerCase()))fail('INVALID','Duplicate fingerprint path');seen.add(f.path.toLowerCase());}
  return value;
}
export function parseWorkflowCacheEntry(input) {
  const value=jsonCopy(input,131_072);fields(value,['schemaVersion','key','scope','grants','value','valueSha256','createdAt','expiresAt','accessedAt','byteLength']);
  if(value.schemaVersion!==1)fail('INVALID','Cache schema');sha(value.key);scope(value.scope);strings(value.grants);sha(value.valueSha256);
  for(const k of ['createdAt','expiresAt','accessedAt'])integer(value[k],0,Number.MAX_SAFE_INTEGER);
  if(value.expiresAt<=value.createdAt||value.accessedAt<value.createdAt)fail('INVALID','Cache times');
  const body=canonical(value.value,WORKFLOW_CACHE_LIMITS.valueBytes);if(value.valueSha256!==digest(body)||value.byteLength!==Buffer.byteLength(body)||hasReference(value.value))fail('CORRUPT','Cache value mismatch');
  return value;
}
export function createMemoryWorkflowCacheStore() {
  const data=new Map();return Object.freeze({async get(id){return data.get(sha(id))??null;},async set(id,value){sha(id);if(!data.has(id)&&data.size>=512)fail('LIMIT','Cache entry limit');data.set(id,parseWorkflowCacheEntry(value));},async list(){return [...data.keys()];},async remove(id){return data.delete(sha(id));},async cleanup(){return {removed:[],preserved:[]};}});
}
export function createWorkflowCache({store=createMemoryWorkflowCacheStore(),authorize,now=Date.now,ttlMs=60_000,maxEntries=128,maxBytes=4_194_304,fillTimeoutMs=60_000}={}) {
  if(typeof authorize!=='function'||typeof now!=='function')fail('INVALID','Host authorization required');integer(ttlMs,1,WORKFLOW_CACHE_LIMITS.ttlMs);integer(maxEntries,1,512);integer(maxBytes,1,WORKFLOW_CACHE_LIMITS.bytes);integer(fillTimeoutMs,1,WORKFLOW_CACHE_LIMITS.fillTimeoutMs);
  const flights=new Map(),unsettled=new Set();let tail=Promise.resolve(),closed=false;const metrics={hits:0,misses:0,bypasses:0,shared:0,evicted:0,corrupt:0,writes:0,writeFailures:0};
  const serial=action=>{const p=tail.then(action);tail=p.catch(()=>{});return p;};
  const check=async(fp,phase,signal)=>authorized(authorize,{scope:fp.descriptor.scope,commandId:fp.descriptor.commandId,grants:fp.descriptor.grants,key:fp.key,phase},signal);
  async function inspectEntry(key){try{const raw=await store.get(key);if(!raw)return null;const value=parseWorkflowCacheEntry(raw);if(value.key!==key)fail('CORRUPT','Cache key mismatch');return value;}catch{metrics.corrupt++;return null;}}
  async function retain(entry){return serial(async()=>{
    const records=[];for(const key of await store.list()){const r=await inspectEntry(key);if(!r||r.expiresAt<=now()){await store.remove(key);metrics.evicted++;}else if(key!==entry.key)records.push(r);}
    records.sort((a,b)=>a.accessedAt-b.accessedAt||a.key.localeCompare(b.key,'en'));
    let bytes=records.reduce((n,r)=>n+r.byteLength,0);
    while(records.length>=maxEntries||bytes+entry.byteLength>maxBytes){const old=records.shift();if(!old)fail('LIMIT','Value exceeds cache budget');await store.remove(old.key);bytes-=old.byteLength;metrics.evicted++;}
    await store.set(entry.key,entry);metrics.writes++;
  });}
  async function produce(fp,compute,signal,retainResult){
    await check(fp,'fill',signal);const raw=Promise.resolve().then(()=>compute({signal}));unsettled.add(raw);raw.then(()=>unsettled.delete(raw),()=>unsettled.delete(raw));
    const value=jsonCopy(await interruptible(raw,signal),WORKFLOW_CACHE_LIMITS.valueBytes);await check(fp,'after-fill',signal);aborted(signal);
    if(retainResult&&!hasReference(value)){
      const at=now(),text=canonical(value),entry={schemaVersion:1,key:fp.key,scope:fp.descriptor.scope,grants:fp.descriptor.grants,value,valueSha256:digest(text),createdAt:at,expiresAt:at+ttlMs,accessedAt:at,byteLength:Buffer.byteLength(text)};
      try{await retain(parseWorkflowCacheEntry(entry));}catch{metrics.writeFailures++;return {value,reason:'store-write-failed'};}
    }
    return {value,reason:hasReference(value)?'secret-result':'computed'};
  }
  return Object.freeze({
    inspect(){return {...metrics,pendingFills:flights.size,unsettled:unsettled.size,closed};},
    async run(input,{compute,signal}={}){
      if(closed)fail('DISPOSED','Cache closed');if(typeof compute!=='function')fail('INVALID','Compute port required');const fp=parseWorkflowFingerprint(input),guard=deadline(signal,fillTimeoutMs);let flight,joined=false;
      try{
        await check(fp,'lookup',guard.signal);
        if(!fp.eligible){if(unsettled.size>=8)fail('LIMIT','Compute concurrency');metrics.bypasses++;const result=await produce(fp,compute,guard.signal,false);return immutable({state:'bypass',reason:fp.reasons.join(','),value:result.value});}
        const entry=await inspectEntry(fp.key);
        if(entry&&entry.expiresAt>now()&&canonical(entry.scope)===canonical(fp.descriptor.scope)&&canonical(entry.grants)===canonical(fp.descriptor.grants)){
          await check(fp,'hit',guard.signal);aborted(guard.signal);metrics.hits++;
          try{await serial(async()=>{const latest=await inspectEntry(fp.key);if(latest&&latest.valueSha256===entry.valueSha256)await store.set(fp.key,{...latest,accessedAt:now()});});}catch{metrics.writeFailures++;}
          await check(fp,'return',guard.signal);if(entry.expiresAt<=now())fail('EXPIRED','Cache value expired during authorization');return immutable({state:'hit',reason:'verified',value:entry.value});
        }
        flight=flights.get(fp.key);joined=!!flight;
        if(!flight){
          if(flights.size>=8||unsettled.size>=8)fail('LIMIT','Cache fill concurrency');metrics.misses++;
          const timer=deadline(undefined,fillTimeoutMs);flight={waiters:0,timer,promise:null};flights.set(fp.key,flight);
          flight.promise=produce(fp,compute,timer.signal,true).finally(()=>{timer.close();if(flights.get(fp.key)===flight)flights.delete(fp.key);});
          flight.promise.catch(()=>{});
        }else metrics.shared++;
        flight.waiters++;const result=await interruptible(flight.promise,guard.signal);await check(fp,'return',guard.signal);
        return immutable({state:joined?'shared':'miss',reason:result.reason,value:result.value});
      }finally{guard.close();if(flight){flight.waiters--;if(flight.waiters===0&&flights.get(fp.key)===flight)flight.timer.controller.abort();}}
    },
    async cleanup(){return serial(async()=>{const removed=[];for(const key of await store.list()){const value=await inspectEntry(key);if(!value||value.expiresAt<=now()){if(await store.remove(key))removed.push(key);}}
      const recovery=await store.cleanup?.()??{removed:[],preserved:[]};return immutable({removed,recovery});});},
    async close(){closed=true;for(const f of flights.values())f.timer.controller.abort();await Promise.allSettled([...flights.values()].map(f=>f.promise));await tail;},
  });
}
