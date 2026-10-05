import type {WorkflowScope,WorkflowStore} from './workflows.mjs';
export interface OwnedWorkflowStoreOptions {readonly directory:string;readonly workspaceRoot:string;readonly scope:WorkflowScope;readonly recoverStaleLock?:boolean;}
export interface OwnedWorkflowStoreInspection {readonly entries:number;readonly bytes:number;readonly problems:readonly string[];readonly orphans:number;readonly unknown:number;readonly queued:number;readonly closed:boolean;readonly directorySynced:boolean;}
export interface OwnedStoreCleanup {readonly removed:readonly string[];readonly preserved:readonly string[];}
export interface NodeWorkflowStore extends WorkflowStore {cleanup(options?:{readonly expiredBefore?:number}):Promise<OwnedStoreCleanup>;inspect():OwnedWorkflowStoreInspection;close():Promise<void>;}
export function createNodeWorkflowStore(options:OwnedWorkflowStoreOptions):Promise<NodeWorkflowStore>;
