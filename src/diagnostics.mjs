import {ErrorCode,PluginSdkError} from './limits.mjs';
import {configurationObject as object,configurationCopy as copy,configurationInteger as integer,freezeConfiguration as freeze} from './configuration-values.mjs';

export const DIAGNOSTIC_LIMITS=Object.freeze({events:256,pending:64,exportBytes:262144,retentionMs:300000,sampleEvery:1000,count:1_000_000_000_000});
export const DIAGNOSTIC_OPERATIONS=Object.freeze(['activation','command','language','transport','workspace','project','job','binary','settings','secret','backend','dispose']);
export const DIAGNOSTIC_RESOURCES=Object.freeze(['plugins','commands','registrations','pendingActivations','pendingOperations','providerOperations','pendingJobs','binaryOperations','pendingCheckpoints','retainedJobs','resolveTokens','semanticEntries','timers','subscriptions','fileHandles','processes','memoryBytes']);
const statuses=Object.freeze(['ok','cancelled','error','disposed']);
const fail=()=>{throw new PluginSdkError(ErrorCode.INVALID_CONTRACT,'Invalid local diagnostic data');};
const timestamp=value=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>Number.MAX_SAFE_INTEGER)fail();return value;};
const spanId=value=>{if(typeof value!=='string'||!/^d[1-9][0-9]{0,15}$/.test(value))fail();};
const safeCode=error=>{try{const value=error&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:undefined;return Object.values(ErrorCode).includes(value)?value:ErrorCode.PROVIDER_FAILED;}catch{return ErrorCode.PROVIDER_FAILED;}};
function metrics(input,ending=false){
  object(input,[],ending?['status','errorCode','outputBytes','resources']:['parentId','inputBytes','queueDepth']);
  if(input.parentId!==undefined)spanId(input.parentId);
  for(const key of ['inputBytes','outputBytes','queueDepth'])if(input[key]!==undefined)integer(input[key],DIAGNOSTIC_LIMITS.count);
  if(input.status!==undefined&&!statuses.includes(input.status)||input.errorCode!==undefined&&!Object.values(ErrorCode).includes(input.errorCode))fail();
  if(input.resources!==undefined){object(input.resources,[],DIAGNOSTIC_RESOURCES);for(const value of Object.values(input.resources))integer(value,DIAGNOSTIC_LIMITS.count);}
  return copy(input,8192);
}
export function parseDiagnosticReport(input){
  const value=copy(input,DIAGNOSTIC_LIMITS.exportBytes);object(value,['schemaVersion','enabled','sampleEvery','retentionMs','capacity','attempted','sampled','dropped','pending','events']);
  if(value.schemaVersion!==1||typeof value.enabled!=='boolean')fail();integer(value.sampleEvery,DIAGNOSTIC_LIMITS.sampleEvery,1);integer(value.retentionMs,DIAGNOSTIC_LIMITS.retentionMs,1);integer(value.capacity,DIAGNOSTIC_LIMITS.events,1);
  for(const key of ['attempted','sampled','dropped'])integer(value[key],DIAGNOSTIC_LIMITS.count);integer(value.pending,DIAGNOSTIC_LIMITS.pending);
  if(!Array.isArray(value.events)||value.events.length>value.capacity||value.sampled>value.attempted||value.dropped>value.attempted||!value.enabled&&(value.attempted||value.sampled||value.dropped||value.pending||value.events.length))fail();
  const ids=new Set();for(const event of value.events){object(event,['id','parentId','operation','startedAt','durationMs','status','inputBytes','outputBytes','queueDepth','resources'],['errorCode']);spanId(event.id);if(ids.has(event.id))fail();ids.add(event.id);if(event.parentId!==null)spanId(event.parentId);if(!DIAGNOSTIC_OPERATIONS.includes(event.operation)||!statuses.includes(event.status))fail();timestamp(event.startedAt);timestamp(event.durationMs);for(const key of ['inputBytes','outputBytes','queueDepth'])if(event[key]!==null)integer(event[key],DIAGNOSTIC_LIMITS.count);object(event.resources,[],DIAGNOSTIC_RESOURCES);for(const count of Object.values(event.resources))integer(count,DIAGNOSTIC_LIMITS.count);if(event.errorCode!==undefined&&!Object.values(ErrorCode).includes(event.errorCode))fail();}
  return freeze(value);
}
/** Opt-in bounded local metadata. No automatic payload, path, error-body or network collection. */
export function createDiagnosticSession(options={}){
  object(options,[],['enabled','now','sampleEvery','retentionMs','capacity']);const enabled=options.enabled??false;if(typeof enabled!=='boolean'||options.now!==undefined&&typeof options.now!=='function')fail();
  const sampleEvery=integer(options.sampleEvery??1,DIAGNOSTIC_LIMITS.sampleEvery,1),retentionMs=integer(options.retentionMs??60000,DIAGNOSTIC_LIMITS.retentionMs,1),capacity=integer(options.capacity??128,DIAGNOSTIC_LIMITS.events,1);
  const now=options.now??(()=>globalThis.performance?.now()??Date.now()),events=[],live=new Map();let attempted=0,sampled=0,dropped=0,sequence=0,closed=false,lastTime=0;
  const count=n=>Math.min(DIAGNOSTIC_LIMITS.count,n+1);
  const time=()=>{const result=timestamp(now());lastTime=Math.max(lastTime,result);return lastTime;};
  const prune=at=>{while(events.length&&events[0].finishedAt<=at-retentionMs)events.shift();for(const [id,entry]of live)if(entry.startedAt<=at-retentionMs){live.delete(id);dropped=count(dropped);}};
  const noop=Object.freeze({id:null,end(){}});
  function begin(operation,input={}){
    if(!DIAGNOSTIC_OPERATIONS.includes(operation))fail();const checked=metrics(input);if(!enabled||closed)return noop;
    const at=time();prune(at);attempted=count(attempted);if((attempted-1)%sampleEvery)return noop;
    if(live.size>=DIAGNOSTIC_LIMITS.pending){dropped=count(dropped);return noop;}
    if(checked.parentId!==undefined&&!live.has(checked.parentId))fail();
    const id='d'+(++sequence),entry={id,parentId:checked.parentId??null,operation,startedAt:at,inputBytes:checked.inputBytes??null,queueDepth:checked.queueDepth??null};live.set(id,entry);sampled=count(sampled);
    return Object.freeze({id,end(output={}){const checked=metrics(output,true);if(!live.has(id))return;const at=time();prune(at);if(!live.has(id))return;live.delete(id);
      const event=freeze({...entry,durationMs:at-entry.startedAt,status:checked.status??'ok',outputBytes:checked.outputBytes??null,resources:checked.resources??{},...(checked.errorCode?{errorCode:checked.errorCode}:{})});
      if(events.length>=capacity)events.shift();events.push({event,finishedAt:at});
    }});
  }
  const bestEnd=(span,error)=>{try{const code=error===undefined?undefined:safeCode(error);span.end(error===undefined?{}:{status:code===ErrorCode.CANCELLED?'cancelled':code===ErrorCode.DISPOSED?'disposed':'error',errorCode:code});}catch{/* profiling cannot change a measured operation */}};
  return Object.freeze({enabled,begin,
    measure(operation,callback,metadata={}){if(typeof callback!=='function')fail();let span=noop;try{span=begin(operation,metadata);}catch{/* caller can validate metadata through begin */}
      let result;try{result=callback(span.id);}catch(e){bestEnd(span,e);throw e;}
      try{if(result&&typeof result.then==='function')return Promise.resolve(result).then(value=>{bestEnd(span);return value;},e=>{bestEnd(span,e);throw e;});}catch(e){bestEnd(span,e);throw e;}
      bestEnd(span);return result;
    },
    snapshot(){if(enabled)prune(time());return parseDiagnosticReport({schemaVersion:1,enabled,sampleEvery,retentionMs,capacity,attempted,sampled,dropped,pending:live.size,events:events.map(item=>item.event)});},
    clear(){events.length=0;},
    dispose(){if(closed)return;closed=true;dropped=Math.min(DIAGNOSTIC_LIMITS.count,dropped+live.size);live.clear();},
  });
}

const hostMethods=Object.freeze({activate:'activation',executeCommand:'command',requestDiagnostics:'language',requestLanguage:'language',resolveCompletion:'language',resolveCodeAction:'language',startCommandJob:'job',cancelJob:'job',readJobArtifact:'binary',readJobBinaryArtifactChunk:'binary',readStoredJobArtifactChunk:'binary',dispose:'dispose'});
/** Explicit adapter, no monkeypatching. Arguments/results pass through without collection. */
export function profileHost(host,session){
  if(!host||typeof host!=='object'||!session||typeof session.begin!=='function')fail();
  const resources=()=>{const report=host.inspect();return Object.fromEntries(DIAGNOSTIC_RESOURCES.filter(key=>typeof report[key]==='number').map(key=>[key,report[key]]));};
  const wrapper={};for(const name of Object.keys(host)){const descriptor=Object.getOwnPropertyDescriptor(host,name);if(!descriptor||!('value'in descriptor)||typeof descriptor.value!=='function')fail();const original=descriptor.value;
    wrapper[name]=!hostMethods[name]?original.bind(host):(...args)=>{
      let span;try{span=session.begin(hostMethods[name],{queueDepth:host.inspect().pendingOperations});}catch{/* diagnostics cannot prevent host execution */}
      const end=error=>{try{const code=error===undefined?undefined:safeCode(error);span?.end({status:code===undefined?'ok':code===ErrorCode.CANCELLED?'cancelled':code===ErrorCode.DISPOSED?'disposed':'error',...(code?{errorCode:code}:{}),resources:resources()});}catch{/* no provider data escapes */}};
      let result;try{result=original.apply(host,args);}catch(e){end(e);throw e;}
      if(result&&typeof result.then==='function')return Promise.resolve(result).then(value=>{end();return value;},e=>{end(e);throw e;});end();return result;
    };
  }return Object.freeze(wrapper);
}
export function profileTransport(transport,session){if(typeof transport!=='function'||!session||typeof session.measure!=='function')fail();return function(...args){return session.measure('transport',()=>transport.apply(this,args));};}
