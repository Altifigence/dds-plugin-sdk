import {ErrorCode} from './limits.mjs';
import {parseJsonValue} from './contracts.mjs';
import {configurationObject as object,configurationInteger as integer,configurationKey as key} from './configuration-values.mjs';
import {hostRuntime} from './host-runtime.mjs';
import {TEST_LIMITS,testFailure} from './testing-runtime.mjs';

export const TEST_FAULTS=Object.freeze(['delay','deny','disconnect','drop','corrupt','exhaust']);
export function createFaultController(runtimeInput){
  const runtime=hostRuntime(runtimeInput),queue=[],pending=new Set();let closed=false;
  const open=()=>{if(closed)throw testFailure(ErrorCode.DISPOSED);};
  const wait=(ms,signal)=>new Promise((resolve,reject)=>{
    let timer;const done=()=>{runtime.clearTimeout(timer);signal.removeEventListener('abort',abort);};
    const abort=()=>{done();reject(signal.reason??testFailure(ErrorCode.CANCELLED));};
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
    if(ms!==null)timer=runtime.setTimeout(()=>{done();resolve();},ms);
  });
  return Object.freeze({
    enqueue(input){open();object(input,['operation','kind'],['delayMs','value']);key(input.operation);if(!TEST_FAULTS.includes(input.kind)||queue.length>=TEST_LIMITS.faults)throw testFailure(ErrorCode.INVALID_CONTRACT);
      if(input.kind==='delay')integer(input.delayMs,86400000);else if(Object.hasOwn(input,'delayMs'))throw testFailure(ErrorCode.INVALID_CONTRACT);
      if(input.kind==='corrupt'&&!Object.hasOwn(input,'value')||input.kind!=='corrupt'&&Object.hasOwn(input,'value'))throw testFailure(ErrorCode.INVALID_CONTRACT);
      queue.push(Object.freeze({operation:input.operation,kind:input.kind,...(input.kind==='delay'?{delayMs:input.delayMs}:{}),...(input.kind==='corrupt'?{value:parseJsonValue(input.value)}:{})}));},
    async invoke(operation,callback,options={}){
      open();key(operation);object(options,[],['signal']);if(typeof callback!=='function'||options.signal!==undefined&&!(options.signal instanceof AbortSignal))throw testFailure(ErrorCode.INVALID_CONTRACT);
      if(options.signal?.aborted)throw testFailure(ErrorCode.CANCELLED);if(pending.size>=TEST_LIMITS.pending)throw testFailure(ErrorCode.BUDGET_EXCEEDED);
      const controller=new AbortController();pending.add(controller);const abort=()=>controller.abort(testFailure(ErrorCode.CANCELLED));options.signal?.addEventListener('abort',abort,{once:true});
      const index=queue.findIndex(item=>item.operation===operation),fault=index<0?null:queue.splice(index,1)[0];
      try{
        if(fault?.kind==='delay')await wait(fault.delayMs,controller.signal);
        if(fault?.kind==='drop')await wait(null,controller.signal);
        const failures={deny:ErrorCode.PERMISSION_DENIED,disconnect:ErrorCode.CAPABILITY_UNAVAILABLE,exhaust:ErrorCode.BUDGET_EXCEEDED};
        if(fault&&failures[fault.kind])throw testFailure(failures[fault.kind]);
        if(controller.signal.aborted)throw controller.signal.reason;
        if(fault?.kind==='corrupt')return fault.value;
        const result=await callback(controller.signal);if(controller.signal.aborted)throw controller.signal.reason;return result;
      }finally{options.signal?.removeEventListener('abort',abort);pending.delete(controller);}
    },
    /** Corrupt delivery order, never repeat the actual operation/effect. */
    events(values,options={}){open();object(options,[],['drop','duplicate','reverse']);if(!Array.isArray(values)||values.length>TEST_LIMITS.faults||options.reverse!==undefined&&typeof options.reverse!=='boolean')throw testFailure(ErrorCode.INVALID_CONTRACT);const result=values.map(parseJsonValue);for(const field of ['drop','duplicate'])if(options[field]!==undefined)integer(options[field],values.length-1);
      if(options.duplicate!==undefined)result.splice(options.duplicate,0,result[options.duplicate]);if(options.drop!==undefined)result.splice(options.drop,1);if(options.reverse)result.reverse();return Object.freeze(result);},
    inspect:()=>Object.freeze({queued:queue.length,pending:pending.size}),
    dispose(){if(closed)return;closed=true;queue.length=0;for(const controller of pending)controller.abort(testFailure(ErrorCode.DISPOSED));},
  });
}
