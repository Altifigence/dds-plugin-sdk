import type {Json,WorkspaceMethod,WorkspaceHello,WorkspaceEntry,WorkspacePlugin} from './workspace-protocol.mjs';
import type {JobOptions,JobSnapshot,JobEvents,JobArtifactContent,JobCapabilities} from './jobs.mjs';
import type {WorkspaceJobWatchOptions,WorkspaceObserver,WorkspaceJobUpdate} from './workspace-observation.mjs';
export {createWorkspaceProject, applyTextEdits} from './workspace-project.mjs';
export {WORKSPACE_OBSERVATION_LIMITS} from './workspace-observation.mjs';
export type {WorkspaceObservationOptions,WorkspaceFileWatchOptions,WorkspaceJobWatchOptions,WorkspaceFileChange,WorkspaceJobUpdate,WorkspaceObserver} from './workspace-observation.mjs';
export type {TextEdit, EditSnapshot, WorkspaceEditSession, WorkspaceProject} from './workspace-project.mjs';
export interface WorkspaceRequestOptions {readonly signal?:AbortSignal;readonly timeoutMs?:number;}
export interface WorkspaceClient {
  readonly binding:WorkspaceHello|undefined;
  connect(options?:WorkspaceRequestOptions):Promise<WorkspaceHello>;
  request(method:WorkspaceMethod,params:Readonly<Record<string,Json>>,options?:WorkspaceRequestOptions):Promise<Json>;
  listFiles(path?:string,options?:WorkspaceRequestOptions):Promise<{entries:readonly WorkspaceEntry[]}>;
  readFile(path:string,options?:WorkspaceRequestOptions):Promise<{path:string;content:string;revision:string}>;
  writeFile(path:string,content:string,expectedRevision:string|null,options?:WorkspaceRequestOptions):Promise<{path:string;revision:string}>;
  mkdir(path:string,options?:WorkspaceRequestOptions):Promise<{path:string}>;
  rename(path:string,newPath:string,expectedRevision?:string,options?:WorkspaceRequestOptions):Promise<{path:string;newPath:string}>;
  remove(path:string,expectedRevision?:string,options?:WorkspaceRequestOptions):Promise<{path:string}>;
  listPlugins(options?:WorkspaceRequestOptions):Promise<{plugins:readonly WorkspacePlugin[]}>;
  runCommand(pluginId:string,commandId:string,input:Json,artifactSha256:string,options?:WorkspaceRequestOptions):Promise<Json>;
  getJobCapabilities(options?:WorkspaceRequestOptions):Promise<JobCapabilities>;
  startCommandJob(pluginId:string,commandId:string,input:Json,artifactSha256:string,job:JobOptions,options?:WorkspaceRequestOptions):Promise<JobSnapshot>;
  getJob(jobId:string,options?:WorkspaceRequestOptions):Promise<JobSnapshot>;
  getJobEvents(jobId:string,after?:number,options?:WorkspaceRequestOptions):Promise<JobEvents>;
  cancelJob(jobId:string,options?:WorkspaceRequestOptions):Promise<JobSnapshot>;
  readJobArtifact(jobId:string,artifactId:string,options?:WorkspaceRequestOptions):Promise<JobArtifactContent>;
  watchJob(jobId:string,options?:WorkspaceJobWatchOptions):WorkspaceObserver<WorkspaceJobUpdate>;
  waitForJob(jobId:string,options?:WorkspaceJobWatchOptions):Promise<JobSnapshot>;
  disconnect():void;dispose():void;
}
export function normalizeWorkspaceUrl(value:string):string;
export function createWorkspaceClient(options:{url:string;token:string;fetch?:typeof globalThis.fetch;timeoutMs?:number}):WorkspaceClient;
