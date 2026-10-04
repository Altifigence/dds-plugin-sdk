import {ErrorCode,PluginSdkError} from './limits.mjs';
import {configurationMethod,configurationObject} from './configuration-values.mjs';

const known=new WeakSet();
const fail=()=>{throw new PluginSdkError(ErrorCode.INVALID_CONTRACT,'Invalid trusted host runtime');};
/** Trusted owner-only clock/entropy port. Never exposed to a plugin. */
export function hostRuntime(input) {
  if(known.has(input))return input;
  if(input!==undefined)configurationObject(input,['now','setTimeout','clearTimeout','randomUUID']);
  const source=input===undefined?{now:()=>Date.now(),setTimeout:(fn,ms)=>globalThis.setTimeout(fn,ms),clearTimeout:id=>globalThis.clearTimeout(id),randomUUID:()=>globalThis.crypto.randomUUID()}:input;
  const now=configurationMethod(source,'now',true),schedule=configurationMethod(source,'setTimeout',true),clear=configurationMethod(source,'clearTimeout',true),uuid=configurationMethod(source,'randomUUID',true);
  const timers=new Map();let sequence=0;
  const runtime=Object.freeze({
    now(){const value=now();if(!Number.isSafeInteger(value)||value<0)fail();return value;},
    randomUUID(){const value=uuid();if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))fail();return value;},
    setTimeout(callback,delay){
      if(typeof callback!=='function'||!Number.isSafeInteger(delay)||delay<0||timers.size>=4096)fail();
      const ticket=++sequence;timers.set(ticket,undefined);
      try{const handle=schedule(()=>{if(!timers.has(ticket))return;timers.delete(ticket);callback();},delay);if(timers.has(ticket))timers.set(ticket,handle);return ticket;}catch(e){timers.delete(ticket);throw e;}
    },
    clearTimeout(ticket){if(!timers.has(ticket))return;const handle=timers.get(ticket);clear(handle);timers.delete(ticket);},
    inspect(){return Object.freeze({timers:timers.size});},
  });known.add(runtime);return runtime;
}
