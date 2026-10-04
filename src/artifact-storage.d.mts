import type {Scope,RequestOptions} from './index.mjs';
import type {BinaryArtifact,BinaryArtifactSource,BinaryChunk} from './artifacts.mjs';
import type {JobStoreIdentity,JobRecovery} from './job-storage.mjs';
export const ARTIFACT_STORE_LIMITS:Readonly<{files:256;fileBytes:1073741824;storeBytes:4294967296;chunkBytes:65536;concurrent:4;retentionMs:604800000}>;
export const DEFAULT_ARTIFACT_STORE_BYTES:268435456;
export interface ArtifactStoreLimits {readonly files:number;readonly fileBytes:number;readonly storeBytes:number;readonly chunkBytes:number;readonly concurrent:number;readonly retentionMs:number;}
export interface StoredArtifact extends JobStoreIdentity {
  readonly snapshotId:string;readonly jobId:string;readonly pluginId:string;readonly pluginArtifactSha256:string;
  readonly kind:'text'|'binary';readonly artifact:BinaryArtifact;readonly capturedAt:number;readonly expiresAt:number;
}
export interface StoredArtifactReference {readonly protocolVersion:1;readonly storage:'snapshot';readonly scope:Scope;readonly snapshot:StoredArtifact;}
export interface StoredArtifactChunk extends BinaryChunk {readonly reference:StoredArtifactReference;}
export interface ArtifactStorageCapabilities {readonly protocolVersion:1;readonly enabled:boolean;readonly identity:JobStoreIdentity|null;readonly limits:ArtifactStoreLimits;}
export type StoredArtifactAvailability='retained'|'expired'|'missing'|'corrupt'|'unsupported';
export type StoredArtifactListEntry={readonly kind:'text'|'binary';readonly artifact:BinaryArtifact}&(
  {readonly storage:'source';readonly availability:'source-reference';readonly snapshot:null}|
  {readonly storage:'snapshot';readonly availability:StoredArtifactAvailability;readonly snapshot:StoredArtifact});
export interface StoredArtifactList {readonly protocolVersion:1;readonly scope:Scope;readonly storeId:string;readonly jobId:string;readonly pluginId:string;readonly pluginArtifactSha256:string;readonly disposition:JobRecovery['disposition'];readonly artifacts:readonly StoredArtifactListEntry[];}
/** Trusted host port; files become visible only after complete verified capture. */
export interface ArtifactStore {
  readonly identity:JobStoreIdentity;readonly limits:ArtifactStoreLimits;
  capture(request:{readonly jobId:string;readonly pluginId:string;readonly pluginArtifactSha256:string;readonly kind:'text'|'binary';readonly artifact:BinaryArtifact},source:BinaryArtifactSource,options?:RequestOptions):Promise<StoredArtifact>;
  status(snapshot:StoredArtifact):StoredArtifactAvailability;
  verify(snapshot:StoredArtifact,options?:RequestOptions):Promise<StoredArtifact>;
  readChunk(snapshot:StoredArtifact,offset:number,length:number,options?:RequestOptions):Promise<BinaryChunk>;
}
export function parseArtifactStoreLimits(value:unknown):ArtifactStoreLimits;
export function parseStoredArtifact(value:unknown):StoredArtifact;
export function parseStoredArtifactReference(value:unknown):StoredArtifactReference;
export function parseStoredArtifactChunk(value:unknown):StoredArtifactChunk;
export function parseArtifactStorageCapabilities(value:unknown):ArtifactStorageCapabilities;
export function parseStoredArtifactList(value:unknown):StoredArtifactList;
