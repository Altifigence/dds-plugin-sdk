import type {StoredArtifact,StoredArtifactReference} from './artifact-storage.mjs';
import type {ArtifactSink} from './artifact-transfer.mjs';
export const BROWSER_ARTIFACT_RESUME_LIMITS:Readonly<{fileBytes:1073741824;chunkBytes:65536;metadataBytes:16384;concurrent:4;retentionMs:86400000}>;
export const DEFAULT_BROWSER_ARTIFACT_RETENTION_MS:3600000;
export interface BrowserArtifactCheckpoint {
  readonly schemaVersion:1;readonly partialId:string;readonly snapshot:StoredArtifact;
  readonly createdAt:number;readonly updatedAt:number;readonly expiresAt:number;readonly state:'partial'|'complete';
  readonly checkpoint:Readonly<{offset:number;sha256:string}>;readonly previousCheckpoint:Readonly<{offset:number;sha256:string}>|null;readonly checksum:string;
}
/** Structural ports are trusted. Native sync access is available only in a dedicated Worker. */
export interface OpfsSyncAccessHandle {read(buffer:Uint8Array,options:{at:number}):number;write(buffer:Uint8Array,options:{at:number}):number;getSize():number;truncate(size:number):void;flush():void;close():void;}
export interface OpfsCheckpointFileHandle {
  readonly kind:'file';getFile():Promise<{readonly size:number;arrayBuffer():Promise<ArrayBuffer>}>;
  createSyncAccessHandle?():Promise<OpfsSyncAccessHandle>;
  createWritable(options:{keepExistingData:boolean}):Promise<{write(data:Uint8Array):Promise<void>;close():Promise<void>;abort():Promise<void>}>;
}
export interface OpfsCheckpointDirectory {readonly kind:'directory';getFileHandle(name:string,options?:{create?:boolean}):Promise<OpfsCheckpointFileHandle>;}
export interface BrowserCheckpointLocks {request<T>(name:string,options:{mode:'exclusive';ifAvailable:true},callback:(lock:unknown|null)=>Promise<T>):Promise<T>;}
export interface OpfsArtifactSinkOptions {readonly directory:OpfsCheckpointDirectory;readonly partialId:string;readonly reference:StoredArtifactReference;readonly retentionMs?:number;readonly locks?:BrowserCheckpointLocks;}
export interface OpfsArtifactSink extends ArtifactSink {readonly partialId:string;readonly names:Readonly<{data:string;metadata:string}>;}
export function createOpfsArtifactSink(options:OpfsArtifactSinkOptions):OpfsArtifactSink;
export function getOpfsArtifactPartialNames(partialId:string):Readonly<{data:string;metadata:string}>;
export function getBrowserArtifactResumeSupport():Readonly<{supported:boolean;dedicatedWorker:boolean;syncAccess:boolean;webLocks:boolean}>;
export function parseBrowserArtifactCheckpoint(value:unknown):BrowserArtifactCheckpoint;
