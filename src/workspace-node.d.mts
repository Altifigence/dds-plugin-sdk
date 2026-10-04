import type {Plugin,PluginHost,Permission,BackendHandler,JsonValue,WorkspaceFile,WorkspaceWriteResult} from './index.mjs';
import type {WorkspaceEntry,WorkspaceHello} from './workspace-protocol.mjs';
import type {BinaryArtifactSource} from './artifacts.mjs';
import type {JobStore,JobStorageOptions} from './job-storage.mjs';
import type {ArtifactStore} from './artifact-storage.mjs';
export {downloadJobBinaryArtifact} from './artifact-download-node.mjs';
export {downloadStoredJobArtifact} from './stored-artifact-download-node.mjs';
export type {StoredArtifactDownloadReceipt} from './stored-artifact-download-node.mjs';
export type {ArtifactDownloadOptions,ArtifactDownloadProgress,ArtifactDownloadReceipt} from './artifact-download-node.mjs';
export interface NodeWorkspace {
  readonly capabilities:{readonly read:true;readonly write:boolean;readonly manage:boolean};
  listFiles(path?:string,options?:{readonly signal?:AbortSignal}):Promise<readonly WorkspaceEntry[]>;
  readFile(path:string,options?:{readonly signal?:AbortSignal}):Promise<WorkspaceFile>;
  captureBinaryFile?(path:string,options?:{readonly signal?:AbortSignal}):Promise<BinaryArtifactSource>;
  writeFile(path:string,content:string,options:{readonly expectedRevision:string|null;readonly signal?:AbortSignal}):Promise<WorkspaceWriteResult>;
  mkdir(path:string,options?:{readonly signal?:AbortSignal}):Promise<{path:string}>;
  rename(path:string,newPath:string,options?:{readonly expectedRevision?:string;readonly signal?:AbortSignal}):Promise<{path:string;newPath:string}>;
  remove(path:string,options?:{readonly expectedRevision?:string;readonly signal?:AbortSignal}):Promise<{path:string}>;
  dispose():void;
}
/** UTF-8 files under one operator-provided real directory; this is not an OS sandbox. */
export function createNodeWorkspace(options:{readonly root:string;readonly writable?:boolean;readonly manage?:boolean;readonly binaryArtifacts?:boolean}):Promise<NodeWorkspace>;
/** Fixed absolute executable/arguments/cwd, explicit environment, bounded JSON stdin/stdout. */
export type ProcessBackend=(input:JsonValue,options?:{readonly signal?:AbortSignal})=>Promise<JsonValue>;
export function createProcessBackend(options:{readonly executable:string;readonly args?:readonly string[];readonly cwd:string;readonly env?:Readonly<Record<string,string>>;readonly timeoutMs?:number;readonly maxOutputBytes?:number}):ProcessBackend;
export interface ConfiguredWorkspacePlugin {readonly plugin:Plugin;readonly artifactSha256:string;readonly licenseText?:string;}
export interface WorkspaceServerOptions {
  /** Server-owned Node workspace only; the operator closes the store after server.close(). */
  readonly jobStorage?:{readonly store:JobStore;readonly artifacts?:ArtifactStore;readonly redact?:JobStorageOptions['redact']};
  readonly jobs?:boolean;
  readonly binaryArtifacts?:boolean;
  readonly root?:string;readonly workspace?:NodeWorkspace;readonly workspaceId:string;readonly name?:string;
  readonly token:string;readonly plugins?:readonly ConfiguredWorkspacePlugin[];readonly grants?:readonly Permission[];
  readonly backends?:Readonly<Record<string,BackendHandler>>;readonly pluginHost?:PluginHost;
  readonly notice:{readonly id:string;readonly version:string;readonly text:string;readonly sha256?:string};
  readonly host?:string;readonly port?:number;readonly writable?:boolean;readonly manage?:boolean;
  readonly allowedOrigins?:readonly string[];readonly timeoutMs?:number;
}
export interface WorkspaceServer {
  readonly url:string;readonly workspaceId:string;readonly generation:string;
  hello():WorkspaceHello;
  close():Promise<void>;
}
/** Starts an authenticated HTTP server; closes owned plugin/workspace ports when closed. */
export function createWorkspaceServer(options:WorkspaceServerOptions):Promise<WorkspaceServer>;
