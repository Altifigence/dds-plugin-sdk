import {SDK_VERSION} from './version.mjs';
import {ErrorCode} from './limits.mjs';
import {DIAGNOSTIC_OPERATIONS,DIAGNOSTIC_RESOURCES,DIAGNOSTIC_LIMITS} from './diagnostics.mjs';
import {TRACE_OPERATIONS} from './testing-trace.mjs';

const base=`https://github.com/Altifigence/dds-plugin-sdk/blob/v${SDK_VERSION}/schemas/`;
const ref=name=>({$ref:base+name+'.schema.json'});
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const integer=(max=Number.MAX_SAFE_INTEGER,min=0)=>({type:'integer',minimum:min,maximum:max});
const text=(maxLength=256)=>({type:'string',minLength:1,maxLength});
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
const list=(items,maxItems)=>({type:'array',items,maxItems});
const sha={type:'string',pattern:'^[a-f0-9]{64}$'},version={type:'string',pattern:'^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-z0-9.-]+)?$'};
const template={enum:['command','language','theme','job','browser','configuration']};
const inventory=object({path:{...text(240),pattern:'^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$'},bytes:integer(1048576),sha256:sha});
const traceEvent=object({sequence:integer(1024,1),at:integer(),fixtureId:{type:'string',pattern:'^[a-z][a-z0-9-]{0,63}$'},operation:{enum:TRACE_OPERATIONS},inputSha256:sha,outputSha256:sha,previousSha256:sha,sha256:sha});
const spanId={type:'string',pattern:'^d[1-9][0-9]{0,15}$'},count=integer(DIAGNOSTIC_LIMITS.count);
const diagnosticEvent=object({id:spanId,parentId:nullable(spanId),operation:{enum:DIAGNOSTIC_OPERATIONS},startedAt:{type:'number',minimum:0,maximum:Number.MAX_SAFE_INTEGER},durationMs:{type:'number',minimum:0,maximum:Number.MAX_SAFE_INTEGER},status:{enum:['ok','cancelled','error','disposed']},inputBytes:nullable(count),outputBytes:nullable(count),queueDepth:nullable(count),resources:object(Object.fromEntries(DIAGNOSTIC_RESOURCES.map(key=>[key,count])),[]),errorCode:{enum:Object.values(ErrorCode)}},['id','parentId','operation','startedAt','durationMs','status','inputBytes','outputBytes','queueDepth','resources']);
export const DEVELOPMENT_SCHEMAS=Object.freeze({
  'development-definition':object({schemaVersion:{const:1},template,commands:list(ref('command'),64),settings:ref('settings-definition'),catalog:ref('locale-catalog'),theme:ref('theme')},['schemaVersion','template','commands']),
  'generation-receipt':object({schemaVersion:{const:1},sdkVersion:version,sourceSha256:sha,files:list(inventory,255),digest:sha}),
  'generation-report':object({schemaVersion:{const:1},directory:text(32768),sdkVersion:version,digest:sha,previousDigest:nullable(sha),current:{type:'boolean'},written:{type:'boolean'},files:list(inventory,256),conflicts:list(text(128),1),ok:{type:'boolean'}},['schemaVersion','directory','sdkVersion','digest','previousDigest','current','written','files','conflicts']),
  'plugin-plan':object({schemaVersion:{const:1},directory:text(32768),pluginId:text(128),template,sdkVersion:version,generationDigest:sha,files:list(inventory,256),conflicts:list(object({path:{const:'.'},reason:{const:'destination_exists'}}),1),writes:{const:false}}),
  'test-trace':object({schemaVersion:{const:1},seed:integer(0xffffffff),fixtureVersion:integer(Number.MAX_SAFE_INTEGER,1),fixtureDigest:sha,events:list(traceEvent,1024),digest:sha}),
  'memory-job-snapshot':object({schemaVersion:{const:1},identity:ref('job-store-identity'),records:list(ref('stored-job'),256),sha256:sha}),
  'diagnostic-report':object({schemaVersion:{const:1},enabled:{type:'boolean'},sampleEvery:integer(1000,1),retentionMs:integer(300000,1),capacity:integer(256,1),attempted:count,sampled:count,dropped:count,pending:integer(64),events:list(diagnosticEvent,256)}),
});
