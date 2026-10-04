import type {JsonValue} from './index.mjs';
import type {JobStore, JobStoreIdentity, StoredJob} from './job-storage.mjs';
export interface NodeJobStore extends JobStore {
  pin(jobId:string):()=>void;
  remove(jobId:string,expectedRevision:number):Promise<{readonly jobId:string;readonly removed:true}>;
  prune():Promise<{readonly removed:readonly string[];readonly retained:readonly string[];readonly bytes:number}>;
  inspect():{readonly identity:JobStoreIdentity;readonly records:number;readonly bytes:number;readonly expired:readonly string[];readonly problems:readonly {readonly jobId:string;readonly disposition:'corrupt'|'unsupported'}[];readonly orphanCount:number;readonly migrationBackups:number;readonly durability:'file-and-directory-sync'|'file-sync-and-rename'};
  close():Promise<void>;
}
export interface NodeJobStoreOptions {
  readonly directory:string;readonly workspaceRoot:string;readonly workspaceId:string;
  readonly retentionMs?:number;readonly maxRecords?:number;readonly maxBytes?:number;
  /** Explicitly reclaim only a same-machine writer whose PID is demonstrably dead. */
  readonly recoverStaleLock?:boolean;
  /** Optional operator import from schemaVersion 0; no historical SDK format is implied. */
  readonly migrateLegacy?:(record:JsonValue,identity:JobStoreIdentity)=>StoredJob|Promise<StoredJob>;
}
export function createNodeJobStore(options:NodeJobStoreOptions):Promise<NodeJobStore>;
