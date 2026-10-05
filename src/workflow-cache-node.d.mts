import type {WorkflowCacheStore} from './workflow-cache.mjs';
import type {OwnedWorkflowStoreOptions,OwnedWorkflowStoreInspection,OwnedStoreCleanup} from './workflows-node.mjs';
export interface NodeWorkflowCacheStore extends WorkflowCacheStore {cleanup():Promise<OwnedStoreCleanup>;inspect():OwnedWorkflowStoreInspection;close():Promise<void>;}
export function createNodeWorkflowCacheStore(options:OwnedWorkflowStoreOptions):Promise<NodeWorkflowCacheStore>;
