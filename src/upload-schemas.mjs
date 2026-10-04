import {UPLOAD_LIMITS,UPLOAD_STATES} from './uploads.mjs';
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const integer=(maximum=Number.MAX_SAFE_INTEGER,minimum=0)=>({type:'integer',minimum,maximum});
const sha={type:'string',pattern:'^[a-f0-9]{64}$'},uuid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'},text={type:'string',minLength:1,maxLength:128},file={type:'string',minLength:1,maxLength:1024};
const scope=object({projectId:uuid,sessionId:uuid});
const limits=object(Object.fromEntries(Object.entries(UPLOAD_LIMITS).map(([key,max])=>[key,integer(max,1)])));
const identity=object({protocolVersion:{const:1},storeId:uuid,workspaceId:uuid,workspaceIdentity:sha,principalId:text});
const spec=object({uploadId:uuid,pluginId:text,artifactSha256:sha,path:file,byteLength:integer(UPLOAD_LIMITS.fileBytes),sha256:sha,expectedRevision:{oneOf:[sha,{type:'null'}]}});
const reference=object({protocolVersion:{const:1},scope,identity,uploadGeneration:uuid,spec,createdAt:integer(),expiresAt:integer()});
const receipt=object({uploadId:uuid,uploadGeneration:uuid,path:file,revision:sha,byteLength:integer(UPLOAD_LIMITS.fileBytes),committedAt:integer(),verified:{const:true}});
const status=object({reference,state:{enum:UPLOAD_STATES},offset:integer(UPLOAD_LIMITS.fileBytes),prefixSha256:sha,updatedAt:integer(),commitReceipt:{oneOf:[receipt,{type:'null'}]}});
const chunk=object({offset:integer(UPLOAD_LIMITS.fileBytes),data:{type:'string',minLength:4,maxLength:4*Math.ceil(UPLOAD_LIMITS.chunkBytes/3),pattern:'^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$'},sha256:sha});
export const UPLOAD_SCHEMAS=Object.freeze({
  'upload-spec':spec,'upload-reference':reference,'upload-chunk':chunk,
  'upload-status':{...status,$comment:'Runtime verifies scope/store/workspace equality, lifetime <=24h, offset <=length, empty/full prefix digests, exact receipt identity and state agreement.'},
  'upload-capabilities':{...object({protocolVersion:{const:1},enabled:{type:'boolean'},scope,identity:{oneOf:[identity,{type:'null'}]},roots:{type:'array',items:{type:'string',maxLength:1024},maxItems:UPLOAD_LIMITS.roots,uniqueItems:true},limits,profile:{const:'local-node-v1'}}),$comment:'Runtime validates canonical paths, scope identity, host budget relationships and disabled fields.'},
});
