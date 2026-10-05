import {SDK_VERSION} from './version.mjs';
import {DATA_SCHEMA_CONTRACT,DATA_SCHEMA_DEFINITIONS} from './data-schema-schemas.mjs';

const base=`https://github.com/Altifigence/dds-plugin-sdk/blob/v${SDK_VERSION}/schemas/`;
const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const text=(maxLength=128,minLength=1)=>({type:'string',minLength,maxLength});
const integer=(maximum=Number.MAX_SAFE_INTEGER,minimum=0)=>({type:'integer',minimum,maximum});
const list=(items,maxItems,minItems=0)=>({type:'array',items,maxItems,minItems});
const nullable=value=>({oneOf:[{type:'null'},value]});
const id={...text(),pattern:'^[a-zA-Z0-9][a-zA-Z0-9._-]*$'},hash={type:'string',pattern:'^[a-f0-9]{64}$'},bool={type:'boolean'},v1={const:1};
const ids={...list(id,64),uniqueItems:true},scope=obj({workspaceId:id,securityScope:id});
const json={$ref:base+'json-value.schema.json'};
const filePath={...text(1024),$comment:'Runtime requires a relative workspace file path without traversal or links.'};
const data=DATA_SCHEMA_CONTRACT;
const command=obj({id,pluginId:id,pluginSha256:hash,inputSchema:data,outputSchema:data,grants:ids});
const binding={oneOf:[obj({value:json}),obj({step:id,path:list(id,8)})]};
const step=obj({id,commandId:id,needs:ids,input:{type:'object',propertyNames:id,additionalProperties:binding,maxProperties:128},grants:ids});
const definition=obj({schemaVersion:v1,id,scope,steps:list(step,64,1),policy:{enum:['fail-fast','continue']},concurrency:integer(8,1),timeoutMs:integer(600000,1),stepTimeoutMs:integer(600000,1),retentionMs:integer(86400000,1)});
const cache=obj({state:{enum:['hit','miss','shared','bypass']},key:hash,reason:text(256)});
const states={enum:['pending','running','succeeded','failed','cancelled','timed_out','blocked','interrupted']};
const artifact=obj({id,path:filePath,revision:hash,byteLength:integer(262144),label:text(256)},['id','path','revision','byteLength']);
const recordStep=obj({id,commandId:id,state:states,jobId:nullable(id),sourceAttemptId:nullable(id),inputSha256:nullable(hash),output:json,outputSha256:nullable(hash),artifacts:list(artifact,32),cache:nullable(cache),reason:nullable(id),startedAt:nullable(integer()),finishedAt:nullable(integer())});
const policy=obj({optIn:bool,deterministic:bool,declaredInputsComplete:bool,secretDependent:bool});
const descriptor=obj({schemaVersion:v1,sdkVersion:{const:SDK_VERSION},scope,commandId:id,pluginSha256:hash,toolSha256:nullable(hash),schemaSha256:hash,settingsSha256:hash,inputSha256:hash,environmentSha256:hash,files:list(obj({path:filePath,byteLength:integer(4194304),sha256:hash}),64),grants:ids,policy});
const position=obj({line:integer(10000000),character:integer(10000000)}),range=obj({start:position,end:position});
const eventData={oneOf:[
  obj({kind:{const:'log'},level:{enum:['debug','info','warning','error']},message:text(16384,0)}),
  obj({kind:{const:'progress'},completed:integer(),total:integer(Number.MAX_SAFE_INTEGER,1),message:text(2048,0)},['kind','completed','total']),
  obj({kind:{const:'diagnostic'},path:filePath,range,severity:{enum:['error','warning','info','hint']},message:text(16384,0),code:text(128,0),source:text(128,0)},['kind','path','range','severity','message']),
  obj({kind:{const:'unknown'},reason:id,message:text(1024,0)}),
]};
const processDefinition=obj({id,version:text(96),approved:{const:true},executable:text(4096),executableSha256:hash,files:list(obj({path:text(4096),sha256:hash}),64),args:list({oneOf:[text(4096),obj({input:id})]},64),versionArgs:list(text(4096),64),expectedVersionOutput:text(256),environment:{type:'object',maxProperties:32,propertyNames:{type:'string',pattern:'^[a-zA-Z_][a-zA-Z0-9_]{0,127}$'},additionalProperties:text(4096,0)}});
const stats=obj({bytes:integer(2097152),events:integer(4096),unknown:integer(4096),peakQueued:integer(8),queued:integer(8),closed:bool,failed:bool},['bytes','events','unknown','peakQueued']);
const features=['completion','hover','definition','references','document-symbols','signature-help','prepare-rename','rename','format-document','format-range','code-actions','semantic-tokens','folding-ranges','inlay-hints','document-symbol-tree'];
const unsupported=['completion-resolve','completion-snippets','code-action-resolve','semantic-tokens-delta','server-commands','dynamic-capabilities','resource-operations','sockets','unversioned-diagnostics'];
const defs=body=>({...body,$defs:DATA_SCHEMA_DEFINITIONS});
export const WORKFLOW_SCHEMAS=Object.freeze({
  'workflow-definition':{...definition,'x-maxUtf8Bytes':1048576,$comment:'Runtime checks acyclic unique steps, existing dependencies, input bindings and stepTimeoutMs <= timeoutMs.'},
  'workflow-plan':defs({...obj({schemaVersion:v1,definition,commands:list(command,64),sha256:hash}),'x-maxUtf8Bytes':1048576,$comment:'Runtime prepares the exact immutable plan, verifies closed input/output schemas and required output paths, rejects secret-reference schemas and hashes the canonical body. Digest approval never substitutes for host authorization.'}),
  'workflow-record':{...obj({schemaVersion:v1,workflowId:id,attemptId:id,parentAttemptId:nullable(id),parentJobId:nullable(id),planSha256:hash,scope,revision:integer(Number.MAX_SAFE_INTEGER,1),state:states,startedAt:integer(),updatedAt:integer(),expiresAt:integer(),steps:list(recordStep,64,1)}),'x-maxUtf8Bytes':2097152,$comment:'Runtime checks output hashes, success-only outputs/artifacts and time ordering. Host restart produces an interrupted view; only an explicitly approved new attempt executes.'},
  'workflow-fingerprint':{...obj({schemaVersion:v1,key:hash,eligible:bool,reasons:{...list(id,8),uniqueItems:true},descriptor}),'x-maxUtf8Bytes':65536,$comment:'Fingerprint generation hashes actual supplied file bytes, all declared inputs and SDK/plugin/tool/schema/settings/environment/scope/grants. Runtime verifies the descriptor digest; completeness and determinism are operator attestations.'},
  'workflow-cache-entry':{...obj({schemaVersion:v1,key:hash,scope,grants:ids,value:json,valueSha256:hash,createdAt:integer(),expiresAt:integer(),accessedAt:integer(),byteLength:integer(65536)}),'x-maxUtf8Bytes':131072,$comment:'Runtime verifies canonical value digest/UTF-8 length, TTL ordering and rejects secret-reference values. Every cache use rechecks current host authorization.'},
  'tool-stream-event':{...obj({schemaVersion:v1,sequence:integer(4096,1),jobId:id,commandId:id,toolId:id,toolVersion:text(96,0),stream:{enum:['stdout','stderr']},data:eventData}),$comment:'Runtime checks ordered ranges, progress <= total and bounded well-formed text; the parser bounds UTF-8 bytes, events, queued writes and callback time.'},
  'trusted-process-definition':{...processDefinition,$comment:'Operator-only configuration. Runtime requires absolute local executable/artifact paths, fixed version arguments, approved true, digest verification and exact bounded version-probe output. The process is trusted code, not sandboxed.'},
  'tool-registration':defs({...obj({process:processDefinition,backendId:id,inputSchema:data,pathInputs:ids,format:{enum:['jsonl','text']},parser:{enum:['plain','typescript']}}),$comment:'Runtime checks required scalar argument slots and declared path inputs. Host authorization is checked before start, on events and after completion.'}),
  'tool-run-receipt':obj({schemaVersion:v1,toolId:id,toolVersion:text(96),jobId:id,commandId:id,state:{enum:['succeeded','failed','cancelled','timed_out']},reason:nullable(text(128)),exitCode:nullable({type:'integer'}),terminationSignal:nullable(text(128)),stream:nullable(stats)}),
  'lsp-capability-matrix':{...obj({schemaVersion:v1,protocol:{const:'3.17'},transport:{const:'stdio'},positionEncoding:{const:'utf-16'},features:list(obj({sdkFeature:{enum:features},method:text(128),supported:bool,reason:{enum:['advertised','not-advertised']}}),15,15),unsupported:{const:unsupported}}),$comment:'Runtime verifies the exact ordered feature/method pairs and reason consistent with support. Matrix support reports negotiation, not successful execution of every server feature.'},
  'lsp-close-receipt':obj({schemaVersion:v1,graceful:bool,reason:nullable(text(128)),ownedProcessClosed:bool,pendingRequests:integer(16)}),
});
