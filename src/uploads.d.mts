import type {WorkspaceClient,WorkspaceRequestOptions} from './workspace-client.mjs';
export interface UploadLimits {readonly fileBytes:number;readonly chunkBytes:number;readonly storeBytes:number;readonly records:number;readonly active:number;readonly pending:number;readonly retentionMs:number;readonly recordBytes:number;readonly roots:number;readonly timeoutMs:number;}
export const UPLOAD_LIMITS:Readonly<UploadLimits>;
export const DEFAULT_UPLOAD_LIMITS:Readonly<UploadLimits>;
export type UploadState='receiving'|'committing'|'committed'|'aborted'|'expired'|'corrupt'|'uncertain';
export const UPLOAD_STATES:readonly UploadState[];
export const EMPTY_UPLOAD_SHA256:string;
export interface UploadIdentity {readonly protocolVersion:1;readonly storeId:string;readonly workspaceId:string;readonly workspaceIdentity:string;readonly principalId:string;}
export interface UploadSpec {readonly uploadId:string;readonly pluginId:string;readonly artifactSha256:string;readonly path:string;readonly byteLength:number;readonly sha256:string;readonly expectedRevision:string|null;}
export interface UploadQuery {readonly uploadId:string;readonly pluginId:string;readonly artifactSha256:string;readonly recover?:boolean;}
export interface UploadReference {readonly protocolVersion:1;readonly scope:{readonly projectId:string;readonly sessionId:string};readonly identity:UploadIdentity;readonly uploadGeneration:string;readonly spec:UploadSpec;readonly createdAt:number;readonly expiresAt:number;}
export interface UploadCommitReceipt {readonly uploadId:string;readonly uploadGeneration:string;readonly path:string;readonly revision:string;readonly byteLength:number;readonly committedAt:number;readonly verified:true;}
export interface UploadStatus {readonly reference:UploadReference;readonly state:UploadState;readonly offset:number;readonly prefixSha256:string;readonly updatedAt:number;readonly commitReceipt:UploadCommitReceipt|null;}
export interface UploadChunk {readonly offset:number;readonly data:string;readonly sha256:string;}
export interface UploadCapabilities {readonly protocolVersion:1;readonly enabled:boolean;readonly scope:{readonly projectId:string;readonly sessionId:string};readonly identity:UploadIdentity|null;readonly roots:readonly string[];readonly limits:UploadLimits;readonly profile:'local-node-v1';}
export interface UploadSource {readonly byteLength:number;read(offset:number,length:number,options?:{readonly signal?:AbortSignal}):Promise<Uint8Array>;}
export interface UploadProgress {readonly phase:'hashing'|'verifying-prefix'|'uploading'|'committed';readonly completed:number;readonly total:number;readonly status:UploadStatus|undefined;}
export interface UploadFileOptions extends Omit<UploadSpec,'byteLength'|'sha256'> {readonly recover?:boolean;readonly signal?:AbortSignal;readonly timeoutMs?:number;readonly requestTimeoutMs?:number;readonly onProgress?:(progress:UploadProgress)=>void;}
export function uploadFile(client:WorkspaceClient,source:UploadSource,options:UploadFileOptions):Promise<UploadStatus>;
export function parseUploadLimits(value:unknown):UploadLimits;
export function parseUploadIdentity(value:unknown):UploadIdentity;
export function parseUploadSpec(value:unknown):UploadSpec;
export function parseUploadQuery(value:unknown):UploadQuery;
export function parseUploadReference(value:unknown):UploadReference;
export function parseUploadCommitReceipt(value:unknown):UploadCommitReceipt;
export function parseUploadStatus(value:unknown):UploadStatus;
export function parseUploadChunk(value:unknown,byteLength?:number):UploadChunk;
export function parseUploadCapabilities(value:unknown):UploadCapabilities;
export function parseUploadRequest(method:string,value:unknown):Readonly<Record<string,unknown>>;
export function parseUploadResult(method:string,value:unknown):UploadCapabilities|UploadStatus;
export function uploadInteger(value:unknown,max?:number,min?:number):number;
export function uploadUuid(value:unknown):string;
