import {WORKSPACE_PROJECT_LIMITS as limits} from './workspace-project-contracts.mjs';
import {PROJECT_WATCH_SCHEMAS} from './project-watch-schemas.mjs';
import {PROJECT_QUERY_SCHEMAS} from './project-query-schemas.mjs';
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const integer=(maximum=Number.MAX_SAFE_INTEGER,minimum=0)=>({type:'integer',minimum,maximum});
const uuid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'};
const scope=object({projectId:uuid,sessionId:uuid});
export const WORKSPACE_PROJECT_SCHEMAS=Object.freeze({
  'workspace-project-capabilities':{...object({protocolVersion:{const:1},enabled:{type:'boolean'},scope,watch:{oneOf:[PROJECT_WATCH_SCHEMAS['project-watch-capabilities'],{type:'null'}]},query:{oneOf:[PROJECT_QUERY_SCHEMAS['project-query-capabilities'],{type:'null'}]},limits:object(Object.fromEntries(Object.entries(limits).map(([key,value])=>[key,key==='leaseMs'?integer(value,limits.minLeaseMs):{const:value}])))}),allOf:[{if:{properties:{enabled:{const:false}}},then:{properties:{watch:{type:'null'},query:{type:'null'}}},else:{properties:{watch:{type:'object'},query:{type:'object'}}}}],$comment:'Runtime requires equal explicit root scopes for watch and query ports.'},
  'workspace-project-poll':{...object({scope,subscriptionId:uuid,after:integer(),event:{oneOf:[PROJECT_WATCH_SCHEMAS['project-watch-event'],{type:'null'}]},expiresAt:integer()}),'x-maxUtf8Bytes':800000,$comment:'Runtime checks initial after=0 has event.cursor=1; subsequent non-null event cursors are greater than after. Clients check request subscription ID, generation, scope, snapshot digest and event continuity.'},
});
