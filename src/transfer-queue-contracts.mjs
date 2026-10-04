import {copyWorkspaceJson,exactObject,requireUuid,WORKSPACE_ERROR_CODES,workspaceFailure} from './workspace-values.mjs';
export const TRANSFER_QUEUE_LIMITS=Object.freeze({transfers:32,concurrency:4,bufferBytes:262_144,chunkBytes:65_536,listeners:16,attempts:5,timeoutMs:1_800_000,bytesPerSecond:1_073_741_824});
export const TRANSFER_STATES=Object.freeze(['queued','running','paused','completed','failed','cancelled']);
export const TRANSFER_PHASES=Object.freeze(['queued','preparing','hashing','verifying-prefix','uploading','receiving','committing','verifying-storage','completed']);
export const TRANSFER_DEFAULTS=Object.freeze({maxTransfers:32,concurrency:4,perConnection:2,bufferBytes:262_144,bytesPerSecond:0,attempts:3,baseDelayMs:100,maxDelayMs:2_000});
const invalid=()=>{throw workspaceFailure('invalid_request','Invalid transfer queue contract');};
export const queueInteger=(n,max=Number.MAX_SAFE_INTEGER,min=0)=>{if(!Number.isSafeInteger(n)||n<min||n>max)invalid();return n;};
export function parseTransferQueueOptions(value={}){
  const v=copyWorkspaceJson(value);exactObject(v,[],Object.keys(TRANSFER_DEFAULTS));const o={...TRANSFER_DEFAULTS,...v};if(v.perConnection===undefined)o.perConnection=Math.min(o.perConnection,o.concurrency);
  queueInteger(o.maxTransfers,32,1);queueInteger(o.concurrency,4,1);queueInteger(o.perConnection,4,1);queueInteger(o.bufferBytes,262_144,65_536);queueInteger(o.bytesPerSecond,1_073_741_824);queueInteger(o.attempts,5,1);queueInteger(o.baseDelayMs,1_000,1);queueInteger(o.maxDelayMs,10_000,o.baseDelayMs);
  if(o.perConnection>o.concurrency||o.bufferBytes%65_536!==0)invalid();return Object.freeze(o);
}
export function parseTransferSnapshot(value){
  const v=copyWorkspaceJson(value);exactObject(v,['protocolVersion','id','connectionId','sequence','kind','state','phase','priority','active','pauseRequested','totalBytes','acknowledgedBytes','transferredBytes','attemptedBytes','retriedBytes','resumedBytes','remainingBytes','retries','verified','verification','commit','partialDisposition','error']);
  if(v.protocolVersion!==1)invalid();requireUuid(v.id);requireUuid(v.connectionId);queueInteger(v.sequence);queueInteger(v.priority,3);
  if(!['upload','download','stored-download'].includes(v.kind)||!TRANSFER_STATES.includes(v.state)||!TRANSFER_PHASES.includes(v.phase))invalid();
  for(const k of ['active','pauseRequested','verified'])if(typeof v[k]!=='boolean')invalid();
  queueInteger(v.totalBytes,1_073_741_824);for(const k of ['acknowledgedBytes','transferredBytes','resumedBytes','remainingBytes'])queueInteger(v[k],v.totalBytes);
  queueInteger(v.attemptedBytes,5_368_709_120);queueInteger(v.retriedBytes,v.attemptedBytes);queueInteger(v.retries,4_294_967_300);
  if(v.acknowledgedBytes!==v.transferredBytes+v.resumedBytes||v.remainingBytes!==v.totalBytes-v.acknowledgedBytes||!['pending','received','stored','upload-commit'].includes(v.verification)||!['not-committed','unknown','committed'].includes(v.commit)||!['discarded','retained','unknown'].includes(v.partialDisposition))invalid();
  if(v.verified!==(v.state==='completed')||v.verified!==(v.verification!=='pending')||v.verified&&(v.remainingBytes!==0||v.phase!=='completed'||v.commit!=='committed'))invalid();
  if(v.verified&&((v.kind==='upload')!==(v.verification==='upload-commit')))invalid();
  if(['completed','failed','cancelled','paused'].includes(v.state)&&v.active||v.state==='paused'&&!v.pauseRequested)invalid();
  if(v.error!==null){exactObject(v.error,['code','message']);if(!WORKSPACE_ERROR_CODES.includes(v.error.code)||typeof v.error.message!=='string'||v.error.message.length>2_048)invalid();}
  if(['failed','cancelled'].includes(v.state)!==(v.error!==null))invalid();return v;
}
