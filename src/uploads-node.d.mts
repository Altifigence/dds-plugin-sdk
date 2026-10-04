import type {NodeWorkspace} from './workspace-node.mjs';
import type {WorkspaceRequestOptions} from './workspace-client.mjs';
import type {UploadLimits,UploadIdentity,UploadCapabilities,UploadSpec,UploadQuery,UploadReference,UploadChunk,UploadStatus,UploadSource} from './uploads.mjs';
export interface NodeUploadConfiguration {readonly directory:string;readonly principalId:string;readonly roots:readonly string[];readonly fileSystem:'local';readonly limits?:Partial<UploadLimits>;readonly recoverStaleLock?:boolean;}
export interface NodeUploadStore {
  readonly identity:UploadIdentity;readonly limits:UploadLimits;
  capabilities():UploadCapabilities;
  begin(spec:UploadSpec,options?:WorkspaceRequestOptions):Promise<UploadStatus>;
  query(query:UploadQuery,options?:WorkspaceRequestOptions):Promise<UploadStatus>;
  write(reference:UploadReference,chunk:UploadChunk,options?:WorkspaceRequestOptions):Promise<UploadStatus>;
  commit(reference:UploadReference,options?:WorkspaceRequestOptions):Promise<UploadStatus>;
  abort(reference:UploadReference,options?:WorkspaceRequestOptions):Promise<UploadStatus>;
  prune(options?:WorkspaceRequestOptions):Promise<{readonly removed:readonly string[];readonly orphans:readonly string[]}>;
  inspect():Readonly<{records:number;active:number;reservedBytes:number;pending:number;orphans:readonly string[];closed:boolean;revoked:boolean;directoryFsync:boolean}>;
  revoke():void;close():Promise<void>;
}
/** authorize must synchronously return true for each current operation; no grants are restored from disk. */
export function createNodeUploadStore(options:NodeUploadConfiguration&{readonly workspace:NodeWorkspace;readonly scope:{readonly projectId:string;readonly sessionId:string};readonly authorize:(spec:UploadSpec)=>true|false}):Promise<NodeUploadStore>;
export function createNodeUploadSource(options:{readonly path:string}):Promise<UploadSource>;
