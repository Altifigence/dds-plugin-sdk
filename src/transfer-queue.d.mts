import type {WorkspaceClient} from './workspace-client.mjs';
import type {UploadSource,UploadFileOptions,UploadStatus} from './uploads.mjs';
import type {BinaryArtifactReference} from './artifacts.mjs';
import type {StoredArtifactReference} from './artifact-storage.mjs';
import type {ArtifactTransferOptions,ArtifactTransferReceipt,BinaryArtifactClient,StoredArtifactClient} from './artifact-transfer.mjs';
export type TransferState='queued'|'running'|'paused'|'completed'|'failed'|'cancelled';
export type TransferPhase='queued'|'preparing'|'hashing'|'verifying-prefix'|'uploading'|'receiving'|'committing'|'verifying-storage'|'completed';
export interface TransferQueueOptions {readonly maxTransfers?:number;readonly concurrency?:number;readonly perConnection?:number;readonly bufferBytes?:number;readonly bytesPerSecond?:number;readonly attempts?:number;readonly baseDelayMs?:number;readonly maxDelayMs?:number;}
export const TRANSFER_QUEUE_LIMITS:Readonly<{transfers:32;concurrency:4;bufferBytes:262144;chunkBytes:65536;listeners:16;attempts:5;timeoutMs:1800000;bytesPerSecond:1073741824}>;
export const TRANSFER_DEFAULTS:Readonly<Required<TransferQueueOptions>>;
export const TRANSFER_STATES:readonly TransferState[];
export const TRANSFER_PHASES:readonly TransferPhase[];
export interface TransferSnapshot {
  readonly protocolVersion:1;readonly id:string;readonly connectionId:string;readonly sequence:number;
  readonly kind:'upload'|'download'|'stored-download';readonly state:TransferState;readonly phase:TransferPhase;
  readonly priority:number;readonly active:boolean;readonly pauseRequested:boolean;readonly totalBytes:number;
  readonly acknowledgedBytes:number;readonly transferredBytes:number;readonly attemptedBytes:number;readonly retriedBytes:number;
  readonly resumedBytes:number;readonly remainingBytes:number;readonly retries:number;readonly verified:boolean;
  readonly verification:'pending'|'received'|'stored'|'upload-commit';readonly commit:'not-committed'|'unknown'|'committed';
  readonly partialDisposition:'discarded'|'retained'|'unknown';readonly error:Readonly<{code:string;message:string}>|null;
}
export interface TransferScheduling {readonly id?:string;readonly priority?:number;}
export interface TransferHandle<T> {readonly id:string;readonly result:Promise<T>;readonly snapshot:TransferSnapshot;pause():TransferSnapshot;resume():TransferSnapshot;cancel():TransferSnapshot;}
export interface TransferQueue {
  readonly limits:Readonly<Required<TransferQueueOptions>>;
  enqueueUpload(client:WorkspaceClient,source:UploadSource,options:UploadFileOptions,scheduling?:TransferScheduling):TransferHandle<UploadStatus>;
  enqueueDownload(client:BinaryArtifactClient,reference:BinaryArtifactReference,options:ArtifactTransferOptions,scheduling?:TransferScheduling):TransferHandle<ArtifactTransferReceipt>;
  enqueueStoredDownload(client:StoredArtifactClient,reference:StoredArtifactReference,options:ArtifactTransferOptions,scheduling?:TransferScheduling):TransferHandle<ArtifactTransferReceipt>;
  get(id:string):TransferSnapshot;list():readonly TransferSnapshot[];
  pause(id:string):TransferSnapshot;resume(id:string):TransferSnapshot;cancel(id:string):TransferSnapshot;
  release(id:string):true;subscribe(listener:(snapshot:TransferSnapshot)=>void):()=>boolean;
  inspect():Readonly<{transfers:number;active:number;peakActive:number;peakChunkBytes:number;pending:number;listeners:number;listenerErrors:number;disposed:boolean}>;
  dispose():Promise<void>;
}
export function createTransferQueue(options?:TransferQueueOptions):TransferQueue;
export function parseTransferQueueOptions(value?:unknown):Readonly<Required<TransferQueueOptions>>;
export function parseTransferSnapshot(value:unknown):TransferSnapshot;
