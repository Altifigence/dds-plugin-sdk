import type {NodeWorkspace} from './workspace-node.mjs';
import type {ProjectWatchOptions,ProjectSnapshot,ProjectWatchEvent,ProjectWatchCapabilities} from './project-watch.mjs';
export type NodeProjectWatchCapabilities=ProjectWatchCapabilities;
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
