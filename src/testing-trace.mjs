import {ErrorCode} from './limits.mjs';
import {parseJsonValue} from './contracts.mjs';
import {configurationObject as object,configurationCopy as copy,configurationInteger as integer,freezeConfiguration as freeze} from './configuration-values.mjs';
import {createIncrementalSha256} from './sha256-stream.mjs';
import {TEST_LIMITS,testFailure} from './testing-runtime.mjs';

export const TRACE_OPERATIONS=Object.freeze(['command','language','workspace','project','job','binary','settings','secret','backend']);
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>{const h=createIncrementalSha256();h.update(new TextEncoder().encode(stable(value)));return h.digest();};
const sha=value=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw testFailure(ErrorCode.INVALID_CONTRACT);};
const fixtureId=value=>{if(typeof value!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(value))throw testFailure(ErrorCode.INVALID_CONTRACT);};
function fixtures(options){
  object(options,['synthetic','seed','fixtureVersion','fixtures'],['now']);
  if(options.synthetic!==true||options.now!==undefined&&typeof options.now!=='function')throw testFailure(ErrorCode.INVALID_CONTRACT);
  integer(options.seed,0xffffffff);integer(options.fixtureVersion,Number.MAX_SAFE_INTEGER,1);
  if(!Array.isArray(options.fixtures)||!options.fixtures.length||options.fixtures.length>64)throw testFailure(ErrorCode.INVALID_CONTRACT);
  const map=new Map();let bytes=0;
  for(const input of options.fixtures){object(input,['id','operation','input','output']);fixtureId(input.id);if(map.has(input.id)||!TRACE_OPERATIONS.includes(input.operation))throw testFailure(ErrorCode.INVALID_CONTRACT);
    const value=freeze({id:input.id,operation:input.operation,input:parseJsonValue(input.input),output:parseJsonValue(input.output)});bytes+=new TextEncoder().encode(stable(value)).length;if(bytes>TEST_LIMITS.workspaceBytes)throw testFailure(ErrorCode.BUDGET_EXCEEDED);
    map.set(value.id,{...value,inputSha256:hash(value.input),outputSha256:hash(value.output)});
  }
  const inventory=[...map.values()].map(({id,operation,inputSha256,outputSha256})=>({id,operation,inputSha256,outputSha256})).sort((a,b)=>a.id<b.id?-1:1);
  return {map,header:{schemaVersion:1,seed:options.seed,fixtureVersion:options.fixtureVersion,fixtureDigest:hash(inventory)}};
}
export function parseTestTrace(input){
  const value=copy(input,TEST_LIMITS.traceBytes,30_000);object(value,['schemaVersion','seed','fixtureVersion','fixtureDigest','events','digest']);
  if(value.schemaVersion!==1)throw testFailure(ErrorCode.VERSION_MISMATCH);integer(value.seed,0xffffffff);integer(value.fixtureVersion,Number.MAX_SAFE_INTEGER,1);sha(value.fixtureDigest);sha(value.digest);
  if(!Array.isArray(value.events)||value.events.length>TEST_LIMITS.traceEvents)throw testFailure(ErrorCode.INVALID_CONTRACT);
  const {events,digest,...header}=value;let previous=hash(header),at=0;
  for(const [i,event]of events.entries()){
    object(event,['sequence','at','fixtureId','operation','inputSha256','outputSha256','previousSha256','sha256']);fixtureId(event.fixtureId);integer(event.at,Number.MAX_SAFE_INTEGER);if(event.at<at||event.sequence!==i+1||!TRACE_OPERATIONS.includes(event.operation))throw testFailure(ErrorCode.CONFLICT);at=event.at;
    for(const key of ['inputSha256','outputSha256','previousSha256','sha256'])sha(event[key]);const {sha256,...body}=event;
    if(event.previousSha256!==previous||hash(body)!==sha256)throw testFailure(ErrorCode.CONFLICT);previous=sha256;
  }
  if(digest!==hash({header,events}))throw testFailure(ErrorCode.CONFLICT);return freeze(value);
}
/** Only explicitly asserted synthetic fixtures. Trace stores IDs and hashes, never payloads. */
export function createTestRecorder(options){
  const {map,header}=fixtures(options),events=[];const now=options.now??(()=>0);let previous=hash(header),lastAt=0,closed=false;
  return Object.freeze({
    record(id,input,output){if(closed)throw testFailure(ErrorCode.DISPOSED);fixtureId(id);const fixture=map.get(id);if(!fixture||hash(parseJsonValue(input))!==fixture.inputSha256||hash(parseJsonValue(output))!==fixture.outputSha256)throw testFailure(ErrorCode.CONFLICT);
      if(events.length>=TEST_LIMITS.traceEvents)throw testFailure(ErrorCode.BUDGET_EXCEEDED);const at=integer(now(),Number.MAX_SAFE_INTEGER);if(at<lastAt)throw testFailure(ErrorCode.CONFLICT);
      const body={sequence:events.length+1,at,fixtureId:id,operation:fixture.operation,inputSha256:fixture.inputSha256,outputSha256:fixture.outputSha256,previousSha256:previous};const event=freeze({...body,sha256:hash(body)});
      // Checking before commit keeps the recorder usable after a rejected append.
      const proposed={...header,events:[...events,event],digest:hash({header,events:[...events,event]})};parseTestTrace(proposed);
      events.push(event);previous=event.sha256;lastAt=at;return event;
    },
    snapshot(){return parseTestTrace({...header,events,digest:hash({header,events})});},
    dispose(){closed=true;map.clear();},
  });
}
/** Pure replay: no effect callback, transport, file access, or backend execution. */
export function createTestReplay(traceInput,options){
  if(options&&Object.hasOwn(options,'now'))throw testFailure(ErrorCode.INVALID_CONTRACT);
  const trace=parseTestTrace(traceInput),{map,header}=fixtures(options);let position=0,closed=false;
  if(hash(header)!==hash({schemaVersion:trace.schemaVersion,seed:trace.seed,fixtureVersion:trace.fixtureVersion,fixtureDigest:trace.fixtureDigest}))throw testFailure(ErrorCode.VERSION_MISMATCH);
  for(const event of trace.events){const fixture=map.get(event.fixtureId);if(!fixture||fixture.operation!==event.operation||fixture.inputSha256!==event.inputSha256||fixture.outputSha256!==event.outputSha256)throw testFailure(ErrorCode.CONFLICT);}
  return Object.freeze({next(id,input){if(closed)throw testFailure(ErrorCode.DISPOSED);const event=trace.events[position];if(!event||id!==event.fixtureId||hash(parseJsonValue(input))!==event.inputSha256)throw testFailure(ErrorCode.CONFLICT);position++;return map.get(id).output;},inspect:()=>Object.freeze({position,remaining:trace.events.length-position}),assertComplete(){if(position!==trace.events.length)throw testFailure(ErrorCode.CONFLICT);},dispose(){closed=true;map.clear();}});
}
