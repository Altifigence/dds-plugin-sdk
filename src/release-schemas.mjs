const obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text=(maxLength=256)=>({type:'string',minLength:1,maxLength});
const hash={type:'string',pattern:'^[a-f0-9]{64}$'},version={...text(96),pattern:'^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$'};
const num={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER},list=(items,maxItems=4096)=>({type:'array',items,maxItems});
const nullable=value=>({oneOf:[value,{type:'null'}]});
const source=obj({url:text(2048),version,sha256:hash});
const files=list(obj({path:text(180),data:{type:'string',maxLength:5592408}}),1024);
const deps={type:'object',maxProperties:32,additionalProperties:version};
const dependency=obj({name:text(128),version,source:text(2048),entry:text(180),type:{enum:['module','commonjs']},dependencies:deps,license:text(),licenseFile:text(180),noticeFile:nullable(text(180)),redistributable:{const:true},files,sha256:hash});
const subject=obj({name:text(),version,sha256:hash});
const statement=obj({schemaVersion:{const:1},subject,publisher:text(128),source:obj({url:text(2048),revision:text(128)}),issuedAt:num,expiresAt:num});
const descriptor=obj({schemaVersion:{const:1},bundleSha256:hash,name:text(),publisher:text(128),pluginId:text(128),version,api:obj({protocolVersion:{const:1},capabilities:list(text(),64),runtime:text(),supportedHosts:list(text(),8)}),grants:list(text(),64),dependencies:list(obj({name:text(128),version,sha256:hash,source:text(2048)}),32),tools:list({type:'object'},64),licenses:list({type:'object'},33),settingsSha256:hash,provenanceSha256:hash,keyId:nullable(text(128))});
const changes=obj(Object.fromEntries(['version','api','grants','dependencies','tools','licenses','settingsSha256','provenanceSha256','keyId'].map(x=>[x,{type:'boolean'}])));
const plan=obj({schemaVersion:{const:1},current:descriptor,candidate:descriptor,migration:obj({id:text(128),reversible:{type:'boolean'}}),jobPolicy:{enum:['wait','retain-old']},changes,externalEffectsUndone:{const:false},sha256:hash});
const manifest=obj({schemaVersion:{const:1},name:text(128),version,revision:text(128),api:{...list(text()),uniqueItems:true},license:obj({name:text(),text:text(131072),notice:{type:'string',maxLength:131072},redistributable:{type:'boolean'}}),files:list(obj({path:text(180),sha256:hash}))});
const snapshot=obj({schemaVersion:{const:1},source,observedAt:num,manifest,manifestSha256:hash});
export const RELEASE_SCHEMAS=Object.freeze({
  'plugin-bundle':{...obj({schemaVersion:{const:1},plugin:obj({archive:{type:'string',maxLength:16777216},metadata:{type:'object'},sha256:hash}),dependencies:deps,packages:list(dependency,32),sbom:{type:'object'}}),$comment:'Runtime additionally verifies canonical JSON, all digests and archive limits, single-version acyclic reachable graph, licenses/NOTICE, total decoded budget, and exact CycloneDX 1.6 SBOM derived from content.'},
  'bundle-dependency':dependency,
  'provenance-statement':statement,
  'provenance-envelope':{...obj({schemaVersion:{const:1},algorithm:{const:'Ed25519'},keyId:text(128),payload:statement,signature:{type:'string',minLength:88,maxLength:88}}),$comment:'Runtime verifies canonical base64 and Ed25519 over DDS-PROVENANCE-V1 plus canonical statement JSON. Trust keys are operator-owned Node KeyObjects; keys are not taken from this envelope.'},
  'provenance-receipt':obj({schemaVersion:{const:1},subject,checksum:{type:'boolean'},signature:{enum:['verified','invalid','unsigned','untrusted-key','unsupported']},publisher:{enum:['verified','unverified']},policy:{enum:['accepted','rejected']},keyId:nullable(text(128)),checkedAt:num,offline:{type:'boolean'},revocationsObservedAt:num,reasons:list(text(),32),executionAuthorized:{const:false}}),
  'plugin-update-plan':{...plan,$comment:'Runtime verifies the plan digest, byte-bound descriptors and current policy. Approval is not transferable to another digest/key/grant/settings set.'},
  'plugin-update-record':obj({schemaVersion:{const:1},revision:{...num,minimum:1},activeSha256:hash,settingsSha256:hash,phase:{enum:['idle','staged','approved','preparing','activated','failed']},plan:nullable(plan),disposition:text()}),
  'upstream-manifest':manifest,
  'upstream-snapshot':snapshot,
  'upstream-candidate':obj({schemaVersion:{const:1},current:snapshot,candidate:snapshot,tagChanged:{type:'boolean'},api:obj({added:list(text()),removed:list(text()),missingRequired:list(text())}),files:obj({added:list(text(180)),removed:list(text(180)),changed:list(text(180))}),licenseChanged:{type:'boolean'},redistributable:{type:'boolean'},compatibility:{enum:['supported','unsupported','unverified']},functional:obj({state:{enum:['passed','failed','unverified']},detail:text(2048)}),patch:obj({expectedSourceSha256:hash,replacementSource:source}),reviewRequired:{const:true},automaticActions:{type:'array',maxItems:0},sha256:hash}),
});
