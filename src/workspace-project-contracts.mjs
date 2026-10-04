import {copyWorkspaceJson,exactObject,requireUuid,workspaceFailure} from './workspace-values.mjs';
import {parseProjectWatchCapabilities,parseProjectWatchEvent,parseProjectSnapshot} from './project-watch.mjs';
import {parseProjectQueryCapabilities,parseProjectQueryPage} from './project-query.mjs';

export const WORKSPACE_PROJECT_LIMITS=Object.freeze({subscriptions:4,leaseMs:30_000,minLeaseMs:250,maxPollMs:1_000,maxWatchMs:1_800_000});
const invalid=()=>{throw workspaceFailure('invalid_request','Invalid workspace project contract');};
function scope(value){exactObject(value,['projectId','sessionId']);requireUuid(value.projectId);requireUuid(value.sessionId);return Object.freeze({...value});}
const integer=(value,min=0,max=Number.MAX_SAFE_INTEGER)=>{if(!Number.isSafeInteger(value)||value<min||value>max)invalid();return value;};

export function parseWorkspaceProjectCapabilities(input){
  const value=copyWorkspaceJson(input);exactObject(value,['protocolVersion','enabled','scope','watch','query','limits']);
  if(value.protocolVersion!==1||typeof value.enabled!=='boolean')invalid();
  const current=scope(value.scope);
  exactObject(value.limits,Object.keys(WORKSPACE_PROJECT_LIMITS));
  for(const [key,limit] of Object.entries(WORKSPACE_PROJECT_LIMITS)){
    if(key==='leaseMs')integer(value.limits.leaseMs,WORKSPACE_PROJECT_LIMITS.minLeaseMs,limit);else if(value.limits[key]!==limit)invalid();
  }
  const watch=value.watch===null?null:parseProjectWatchCapabilities(value.watch),query=value.query===null?null:parseProjectQueryCapabilities(value.query);
  if(value.enabled?watch===null||query===null:watch!==null||query!==null)invalid();
  if(watch&&JSON.stringify(watch.roots)!==JSON.stringify(query.roots))invalid();
  return Object.freeze({...value,scope:current,watch,query});
}
export function parseWorkspaceProjectPoll(input){
  const value=copyWorkspaceJson(input,{maxBytes:800_000,maxNodes:40_000});exactObject(value,['scope','subscriptionId','after','event','expiresAt']);
  const current=scope(value.scope);requireUuid(value.subscriptionId);integer(value.after);integer(value.expiresAt);
  const event=value.event===null?null:parseProjectWatchEvent(value.event);
  if(value.after===0?(event===null||event.cursor!==1):event!==null&&event.cursor<=value.after)invalid();
  return Object.freeze({...value,scope:current,event});
}
export function parseWorkspaceProjectResult(method,value){
  if(method==='projects.capabilities')return parseWorkspaceProjectCapabilities(value);
  if(method==='projects.watch.start'||method==='projects.watch.next')return parseWorkspaceProjectPoll(value);
  if(method==='projects.snapshot'){exactObject(value,['scope','snapshot']);return Object.freeze({scope:scope(value.scope),snapshot:parseProjectSnapshot(value.snapshot)});}
  if(method==='projects.query'){exactObject(value,['scope','page']);return Object.freeze({scope:scope(value.scope),page:parseProjectQueryPage(value.page)});}
  if(!['projects.watch.stop','projects.query.release'].includes(method))invalid();
  const key=method==='projects.watch.stop'?'stopped':'released';exactObject(value,['scope',key]);if(typeof value[key]!=='boolean')invalid();return Object.freeze({scope:scope(value.scope),[key]:value[key]});
}
