import type {PluginUpdateJournal,PluginUpdateRecord} from './updates.mjs';
export function inspectNodeUpdateJournal(options:{readonly directory:string}):Promise<{state:'readable';record:PluginUpdateRecord|null;total:number}|{state:'unreadable';record:null;errorCode:string}>;
export function createNodeUpdateJournal(options:{readonly directory:string;readonly workspaceRoot:string;readonly recoverStaleLock?:boolean}):Promise<PluginUpdateJournal & {close():Promise<void>}>;
