import {ErrorCode} from './limits.mjs';
import {parseJobId} from './jobs.mjs';
import {parseJobStoreIdentity,parseStoredJob,JOB_STORE_LIMITS} from './job-storage.mjs';
import {configurationObject as object,configurationInteger as integer,freezeConfiguration} from './configuration-values.mjs';
import {createIncrementalSha256} from './sha256-stream.mjs';
import {testFailure} from './testing-runtime.mjs';

const encode=value=>new TextEncoder().encode(JSON.stringify(value));
const hash=value=>{const h=createIncrementalSha256();h.update(encode(value));return h.digest();};
/** Synthetic memory checkpoints, not filesystem durability or crash-consistent storage. */
export function createMemoryJobStore(options){
  object(options,['identity'],['snapshot','faults']);const identity=parseJobStoreIdentity(options.identity),records=new Map(),pins=new Map(),damaged=new Map();let pending=0,closed=false,bytes=0;
  const open=()=>{if(closed)throw testFailure(ErrorCode.DISPOSED);};
  function checked(value){const record=parseStoredJob(value);if(['storeId','workspaceId','workspaceIdentity'].some(key=>record[key]!==identity[key]))throw testFailure(ErrorCode.CONFLICT);return record;}
  function restore(value){object(value,['schemaVersion','identity','records','sha256']);if(value.schemaVersion!==1)throw testFailure(ErrorCode.VERSION_MISMATCH);if(JSON.stringify(parseJobStoreIdentity(value.identity))!==JSON.stringify(identity)||!Array.isArray(value.records)||value.records.length>JOB_STORE_LIMITS.records)throw testFailure(ErrorCode.CONFLICT);
    for(const item of value.records){const record=checked(item);if(records.has(record.snapshot.jobId))throw testFailure(ErrorCode.CONFLICT);records.set(record.snapshot.jobId,record);bytes+=encode(record).length;}
    if(bytes>JOB_STORE_LIMITS.storeBytes||value.sha256!==hash({schemaVersion:1,identity,records:[...records.values()]}))throw testFailure(ErrorCode.CONFLICT);
  }
  if(options.snapshot!==undefined)restore(options.snapshot);
  const api=Object.freeze({identity,limits:JOB_STORE_LIMITS,
    has(id){open();parseJobId(id);return records.has(id)||damaged.has(id);},
    get(id){open();parseJobId(id);if(damaged.has(id))throw testFailure(damaged.get(id)==='corrupt'?ErrorCode.CONFLICT:ErrorCode.VERSION_MISMATCH);return records.get(id)??null;},
    entries(){open();return Object.freeze([...records.values()].filter(record=>!damaged.has(record.snapshot.jobId)));},
    pin(id){open();parseJobId(id);if(pins.size>=JOB_STORE_LIMITS.records&&!pins.has(id))throw testFailure(ErrorCode.BUDGET_EXCEEDED);pins.set(id,(pins.get(id)??0)+1);let active=true;return()=>{if(!active)return;active=false;const n=(pins.get(id)??0)-1;if(n>0)pins.set(id,n);else pins.delete(id);};},
    async write(value,expectedRevision){open();integer(expectedRevision,Number.MAX_SAFE_INTEGER);const record=checked(value);if(pending>=JOB_STORE_LIMITS.pendingWrites)throw testFailure(ErrorCode.BUDGET_EXCEEDED);pending++;
      const commit=()=>{open();const id=record.snapshot.jobId,before=records.get(id);if(damaged.has(id)||(before?.revision??0)!==expectedRevision||record.revision!==expectedRevision+1)throw testFailure(ErrorCode.CONFLICT);const next=bytes-(before?encode(before).length:0)+encode(record).length;if(!before&&records.size>=JOB_STORE_LIMITS.records||next>JOB_STORE_LIMITS.storeBytes)throw testFailure(ErrorCode.BUDGET_EXCEEDED);records.set(id,record);bytes=next;return record;};
      try{return await (options.faults?options.faults.invoke('store.write',commit):Promise.resolve().then(commit));}finally{pending--;}
    },
    async flush(){open();if(pending)throw testFailure(ErrorCode.CONFLICT);},
    snapshot(){open();const body={schemaVersion:1,identity,records:[...records.values()]};return freezeConfiguration({...body,sha256:hash(body)});},
    markUnavailable(id,kind){open();parseJobId(id);if(!['corrupt','unsupported'].includes(kind)||!records.has(id))throw testFailure(ErrorCode.INVALID_CONTRACT);damaged.set(id,kind);},
    inspect:()=>Object.freeze({records:records.size,bytes,pins:[...pins.values()].reduce((a,b)=>a+b,0),pending}),
    dispose(){closed=true;records.clear();damaged.clear();bytes=0;},
  });return api;
}
