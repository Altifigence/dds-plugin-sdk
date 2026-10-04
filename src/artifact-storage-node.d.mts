import type {NodeJobStore} from './job-storage-node.mjs';
import type {ArtifactStore,ArtifactStoreLimits,StoredArtifact} from './artifact-storage.mjs';
import type {JobStoreIdentity} from './job-storage.mjs';
export interface NodeArtifactStore extends ArtifactStore {
  remove(snapshot:StoredArtifact):Promise<{readonly snapshotId:string;readonly removed:true}>;
  prune(options?:{readonly orphans?:boolean}):Promise<{readonly removed:readonly string[];readonly retained:readonly string[];readonly removedOrphans:readonly string[];readonly bytes:number}>;
  inspect():{readonly identity:JobStoreIdentity;readonly files:number;readonly bytes:number;readonly limits:ArtifactStoreLimits;readonly activeReaders:number;readonly expired:readonly string[];readonly problems:readonly {readonly snapshotId:string;readonly disposition:'missing'|'corrupt'|'unsupported'}[];readonly orphanCount:number;readonly records:readonly StoredArtifact[]};
  close():Promise<void>;
}
export interface NodeArtifactStoreOptions {readonly jobStore:NodeJobStore;readonly maxFiles?:number;readonly maxBytes?:number;readonly maxFileBytes?:number;readonly retentionMs?:number;}
export function createNodeArtifactStore(options:NodeArtifactStoreOptions):Promise<NodeArtifactStore>;
