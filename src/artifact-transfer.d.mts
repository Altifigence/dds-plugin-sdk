import type {BinaryArtifact,BinaryArtifactReference} from './artifacts.mjs';
import type {StoredArtifactReference} from './artifact-storage.mjs';
import type {WorkspaceClient} from './workspace-client.mjs';
import {WorkspaceError} from './workspace-protocol.mjs';
export const ARTIFACT_TRANSFER_LIMITS:Readonly<{fileBytes:1073741824;chunkBytes:65536;concurrent:4;timeoutMs:1800000;queuedChunks:1}>;
export interface IncrementalSha256 {readonly byteLength:number;update(bytes:Uint8Array):IncrementalSha256;digest():string;}
export function createIncrementalSha256():IncrementalSha256;
export interface ArtifactSinkCapabilities {readonly kind:'caller'|'file-system-access'|'opfs';readonly seek:boolean;readonly readback:boolean;readonly persistence:'none'|'on-commit'|'per-checkpoint';readonly abort:'discard'|'retain'|'unknown';}
export interface ArtifactSinkReader {readonly byteLength:number;read(offset:number,length:number,options:{readonly signal:AbortSignal}):Promise<Uint8Array>;}
export interface ArtifactSinkSession {
  readonly recovery?:{readonly offset:number;readonly sha256:string;read(offset:number,length:number,options:{readonly signal:AbortSignal}):Promise<Uint8Array>};
  write(input:{readonly offset:number;readonly bytes:Uint8Array;readonly signal:AbortSignal}):Promise<void>;
  commit(options:{readonly signal:AbortSignal}):Promise<void>;
  abort(options:{readonly reason:unknown}):Promise<void>;
  readback?(options:{readonly signal:AbortSignal}):Promise<ArtifactSinkReader>;
  close?():Promise<void>;
}
/** A trusted caller port must not retain unbounded chunks and must cooperate with cancellation. */
export interface ArtifactSink {readonly capabilities:ArtifactSinkCapabilities;open(options:{readonly artifact:BinaryArtifact;readonly signal:AbortSignal;readonly resume?:boolean;readonly storedReference?:StoredArtifactReference}):Promise<ArtifactSinkSession>;}
export interface ArtifactTransferProgress {readonly phase:'verifying-prefix'|'receiving'|'committing'|'verifying-storage'|'completed';readonly receivedBytes:number;readonly writtenBytes:number;readonly totalBytes:number;readonly resumedBytes:number;readonly verified:boolean;}
export interface ArtifactTransferMetrics {readonly chunks:number;readonly peakQueuedChunks:number;readonly peakDecodedBytes:number;readonly maxChunkWorkMs:number;readonly elapsedMs:number;}
export interface ArtifactTransferReceipt {readonly protocolVersion:1;readonly artifact:BinaryArtifact;readonly receivedBytes:number;readonly resumedBytes:number;readonly receivedSha256:string;readonly storedSha256:string|null;readonly verification:'received'|'stored';readonly committed:true;readonly sink:ArtifactSinkCapabilities;readonly metrics:ArtifactTransferMetrics;}
export interface ArtifactTransferPartial {readonly receivedBytes:number;readonly resumedBytes?:number;readonly writtenBytes:number;readonly receivedVerified:boolean;readonly storedVerified:boolean;readonly commit:'not-committed'|'unknown'|'committed';readonly disposition:'discarded'|'retained'|'unknown';}
export class ArtifactTransferError extends WorkspaceError {constructor(code:string,message:string,partial:ArtifactTransferPartial);readonly partial:ArtifactTransferPartial;}
export interface ArtifactTransferOptions {readonly sink:ArtifactSink;readonly resume?:boolean;readonly signal?:AbortSignal;readonly timeoutMs?:number;readonly requestTimeoutMs?:number;readonly onProgress?:(progress:ArtifactTransferProgress)=>void;}
export type BinaryArtifactClient=Pick<WorkspaceClient,'binding'|'getBinaryArtifactCapabilities'|'getJobBinaryArtifact'|'readJobBinaryArtifactChunk'>;
export type StoredArtifactClient=Pick<WorkspaceClient,'binding'|'getArtifactStorageCapabilities'|'getStoredJobArtifact'|'readStoredJobArtifactChunk'>;
export function parseArtifactSinkCapabilities(value:unknown):ArtifactSinkCapabilities;
export function parseArtifactTransferReceipt(value:unknown):ArtifactTransferReceipt;
export function streamJobBinaryArtifact(client:BinaryArtifactClient,reference:BinaryArtifactReference,options:ArtifactTransferOptions):Promise<ArtifactTransferReceipt>;
export function streamStoredJobArtifact(client:StoredArtifactClient,reference:StoredArtifactReference,options:ArtifactTransferOptions):Promise<ArtifactTransferReceipt>;
