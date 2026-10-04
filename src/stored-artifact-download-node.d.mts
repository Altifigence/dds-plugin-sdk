import type {WorkspaceClient} from './workspace-client.mjs';
import type {StoredArtifactReference} from './artifact-storage.mjs';
import type {ArtifactDownloadOptions,ArtifactDownloadReceipt} from './artifact-download-node.mjs';
export interface StoredArtifactDownloadReceipt extends ArtifactDownloadReceipt {readonly storage:'snapshot';readonly snapshotId:string;readonly storeId:string;}
export function downloadStoredJobArtifact(client:WorkspaceClient,reference:StoredArtifactReference,options:ArtifactDownloadOptions):Promise<StoredArtifactDownloadReceipt>;
