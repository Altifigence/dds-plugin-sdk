import type {NodeProjectWatcher} from './project-watch-node.mjs';
import type {ProjectTreeOptions,ProjectFileSearchOptions,ProjectTextSearchOptions,ProjectQueryPage,ProjectQueryCapabilities} from './project-query.mjs';
export type NodeProjectQueryCapabilities=ProjectQueryCapabilities;
export interface NodeProjectQueries {
  readonly capabilities:NodeProjectQueryCapabilities;
  listTree(options:ProjectTreeOptions,request?:{readonly signal?:AbortSignal}):Promise<ProjectQueryPage>;
  searchFiles(options:ProjectFileSearchOptions,request?:{readonly signal?:AbortSignal}):Promise<ProjectQueryPage>;
  searchText(options:ProjectTextSearchOptions,request?:{readonly signal?:AbortSignal}):Promise<ProjectQueryPage>;
  releaseCursor(cursor:string):boolean;
  inspect():Readonly<{activeQueries:number;views:number;retainedBytes:number;closed:boolean}>;
  revoke():void;
  dispose():void;
}
export function createNodeProjectQueries(options:{readonly watcher:NodeProjectWatcher;readonly cursorTtlMs?:number}):NodeProjectQueries;
