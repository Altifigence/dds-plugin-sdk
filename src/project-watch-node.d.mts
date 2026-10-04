import type {NodeWorkspace} from './workspace-node.mjs';
import type {ProjectWatchOptions,ProjectSnapshot,ProjectWatchEvent,PROJECT_WATCH_LIMITS} from './project-watch.mjs';
export interface NodeProjectWatchCapabilities {readonly version:1;readonly supported:true;readonly platform:'win32'|'linux';readonly fileSystem:'local';readonly filesystemType:string;readonly mode:'native-hints-with-reconciliation';readonly rename:'delete-create';readonly roots:readonly string[];readonly limits:typeof PROJECT_WATCH_LIMITS;}
export interface NodeProjectWatcher {
  readonly capabilities:NodeProjectWatchCapabilities;
  snapshot(options:ProjectWatchOptions,request?:{readonly signal?:AbortSignal}):Promise<ProjectSnapshot>;
  watch(options:ProjectWatchOptions,request?:{readonly signal?:AbortSignal}):AsyncIterableIterator<ProjectWatchEvent>;
  inspect():Readonly<{scans:number;bytesRead:number;filesHashed:number;nativeHints:number;overflows:number;lastScanMs:number;maxScanMs:number;pendingScans:number;observers:number;nativeHandles:number;queuedEvents:number;closed:boolean}>;
  revoke():void;
  dispose():void;
}
/** Only explicitly configured local Windows/Linux filesystems; roots are workspace-relative. */
export function createNodeProjectWatcher(options:{readonly workspace:NodeWorkspace;readonly roots:readonly string[];readonly fileSystem:'local'}):Promise<NodeProjectWatcher>;
