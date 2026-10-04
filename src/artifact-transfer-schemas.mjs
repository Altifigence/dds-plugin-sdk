import {ARTIFACT_TRANSFER_LIMITS as limits} from './artifact-transfer.mjs';
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const integer=(maximum=limits.fileBytes)=>({type:'integer',minimum:0,maximum});
const sha={type:'string',pattern:'^[a-f0-9]{64}$'};
const capabilities=object({kind:{enum:['caller','file-system-access','opfs']},seek:{type:'boolean'},readback:{type:'boolean'},persistence:{enum:['none','on-commit','per-checkpoint']},abort:{enum:['discard','retain','unknown']}});
const artifact={...object({id:{type:'string',minLength:1,maxLength:128},path:{type:'string',minLength:1,maxLength:1024},revision:sha,byteLength:integer(),label:{type:'string',minLength:1,maxLength:256}}),required:['id','path','revision','byteLength']};
export const ARTIFACT_TRANSFER_SCHEMAS=Object.freeze({
  'artifact-sink-capabilities':capabilities,
  'artifact-transfer-receipt':{...object({protocolVersion:{const:1},artifact,receivedBytes:integer(),resumedBytes:integer(),receivedSha256:sha,storedSha256:{oneOf:[sha,{type:'null'}]},verification:{enum:['received','stored']},committed:{const:true},sink:capabilities,metrics:object({chunks:integer(limits.fileBytes+1),peakQueuedChunks:integer(1),peakDecodedBytes:integer(limits.chunkBytes),maxChunkWorkMs:{type:'number',minimum:0},elapsedMs:{type:'number',minimum:0}})}),$comment:'Runtime verifies exact byte totals, whole hashes equal the reference, and stored verification iff the sink supports and completed readback.'},
});
