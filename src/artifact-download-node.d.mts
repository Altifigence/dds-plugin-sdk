import type {WorkspaceClient} from './workspace-client.mjs';
import type {BinaryArtifactReference} from './artifacts.mjs';

export interface ArtifactDownloadProgress {readonly receivedBytes:number;readonly totalBytes:number;readonly resumedBytes:number;readonly verified:false;}
export interface ArtifactDownloadOptions {
  /** Absolute destination in an existing real directory. Never overwritten. */
  readonly destination:string;
  /** Explicitly reuse destination + '.dds-part'; the prefix is rehashed. */
  readonly resume?:boolean;
  readonly signal?:AbortSignal;
  /** Total deadline, default and maximum 30 minutes. */
  readonly timeoutMs?:number;
  /** Per HTTP request, default 5 seconds and maximum 30 seconds. */
  readonly requestTimeoutMs?:number;
  readonly onProgress?:(progress:ArtifactDownloadProgress)=>void;
}
export interface ArtifactDownloadReceipt {readonly path:string;readonly revision:string;readonly byteLength:number;readonly resumedBytes:number;readonly verified:true;}
export function downloadJobBinaryArtifact(client:WorkspaceClient,reference:BinaryArtifactReference,options:ArtifactDownloadOptions):Promise<ArtifactDownloadReceipt>;
