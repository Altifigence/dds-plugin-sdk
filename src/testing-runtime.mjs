import {ErrorCode,PluginSdkError} from './limits.mjs';
import {configurationObject as object,configurationInteger as integer} from './configuration-values.mjs';

export const TEST_LIMITS=Object.freeze({timers:4096,steps:10000,pending:64,faults:256,files:256,fileBytes:262144,workspaceBytes:4194304,traceEvents:1024,traceBytes:1048576,resources:1024});
export const testFailure=code=>new PluginSdkError(code,'Synthetic test operation failed');
export async function flushTestMicrotasks(turns=32){integer(turns,1024,1);for(let i=0;i<turns;i++)await Promise.resolve();}
/** Explicit virtual time. Seeded identifiers are not cryptographic entropy. */
export function createTestClock(options={}) {
  object(options,[],['seed','start']);const seed=integer(options.seed??1,0xffffffff),start=integer(options.start??1700000000000,Number.MAX_SAFE_INTEGER-86400000);
  let random=seed,now=start,sequence=0,closed=false,advancing=false;const timers=new Map();
  const open=()=>{if(closed)throw testFailure(ErrorCode.DISPOSED);};
  const draw=()=>{random=(random+0x6d2b79f5)>>>0;let t=random;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
  const runtime=Object.freeze({
    now:()=>now,
    randomUUID(){open();const bytes=Array.from({length:16},()=>Math.floor(draw()*256));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const s=bytes.map(b=>b.toString(16).padStart(2,'0')).join('');return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');},
    setTimeout(callback,delay){open();integer(delay,86400000);if(typeof callback!=='function')throw testFailure(ErrorCode.INVALID_CONTRACT);if(timers.size>=TEST_LIMITS.timers||now+delay>Number.MAX_SAFE_INTEGER)throw testFailure(ErrorCode.BUDGET_EXCEEDED);const id=++sequence;timers.set(id,{at:now+delay,callback});return id;},
    clearTimeout:id=>{timers.delete(id);},
  });
  const next=()=>[...timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
  async function drive(target,idle,maxSteps){
    open();if(advancing)throw testFailure(ErrorCode.CONFLICT);integer(maxSteps,TEST_LIMITS.steps,1);advancing=true;
    try{await flushTestMicrotasks();let steps=0;for(;;){const item=next();if(!item||!idle&&item[1].at>target)break;if(++steps>maxSteps)throw testFailure(ErrorCode.BUDGET_EXCEEDED);now=item[1].at;timers.delete(item[0]);item[1].callback();await flushTestMicrotasks();}if(!idle)now=target;await flushTestMicrotasks();return Object.freeze({now,timers:timers.size,steps});}
    finally{advancing=false;}
  }
  return Object.freeze({seed,runtime,now:runtime.now,advance(ms,options={}){object(options,[],['maxSteps']);integer(ms,86400000);if(now+ms>Number.MAX_SAFE_INTEGER)throw testFailure(ErrorCode.BUDGET_EXCEEDED);return drive(now+ms,false,options.maxSteps??TEST_LIMITS.steps);},runUntilIdle(options={}){object(options,[],['maxSteps']);return drive(now,true,options.maxSteps??TEST_LIMITS.steps);},inspect:()=>Object.freeze({now,timers:timers.size,disposed:closed}),dispose(){closed=true;timers.clear();}});
}

export const TEST_RESOURCE_KINDS=Object.freeze(['file-handle','process','subscription','timer','operation']);
/** Tracks only resources explicitly registered by their owner, never arbitrary OS handles. */
export function createTestResources(){
  const live=new Map();let sequence=0,closed=false;
  const release=id=>{const entry=live.get(id);if(!entry)return Promise.resolve();if(entry.releasing)return entry.releasing;entry.releasing=Promise.resolve().then(entry.dispose).then(()=>{live.delete(id);},e=>{entry.releasing=undefined;throw e;});return entry.releasing;};
  return Object.freeze({
    track(kind,dispose){if(closed)throw testFailure(ErrorCode.DISPOSED);if(!TEST_RESOURCE_KINDS.includes(kind)||typeof dispose!=='function')throw testFailure(ErrorCode.INVALID_CONTRACT);if(live.size>=TEST_LIMITS.resources)throw testFailure(ErrorCode.BUDGET_EXCEEDED);const id=++sequence;live.set(id,{kind,dispose});return Object.freeze({release:()=>release(id)});},
    inspect(){return Object.freeze(Object.fromEntries(TEST_RESOURCE_KINDS.map(kind=>[kind,[...live.values()].filter(item=>item.kind===kind).length])));},
    assertEmpty(){if(live.size)throw testFailure(ErrorCode.CONFLICT);},
    async dispose(){closed=true;const results=await Promise.allSettled([...live.keys()].map(release));const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;},
  });
}
