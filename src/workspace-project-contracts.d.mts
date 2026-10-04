import type {ProjectWatchCapabilities,ProjectWatchEvent} from './project-watch.mjs';
import type {ProjectQueryCapabilities} from './project-query.mjs';
export const WORKSPACE_PROJECT_LIMITS:Readonly<{subscriptions:4;leaseMs:30000;minLeaseMs:250;maxPollMs:1000;maxWatchMs:1800000}>;
export interface WorkspaceProjectCapabilities {readonly protocolVersion:1;readonly enabled:boolean;readonly scope:{readonly projectId:string;readonly sessionId:string};readonly watch:ProjectWatchCapabilities|null;readonly query:ProjectQueryCapabilities|null;readonly limits:Omit<typeof WORKSPACE_PROJECT_LIMITS,'leaseMs'>&{readonly leaseMs:number};}
export interface WorkspaceProjectPoll {readonly scope:{readonly projectId:string;readonly sessionId:string};readonly subscriptionId:string;readonly after:number;readonly event:ProjectWatchEvent|null;readonly expiresAt:number;}
export interface WorkspaceProjectWatchOptions {readonly signal?:AbortSignal;readonly requestTimeoutMs?:number;readonly timeoutMs?:number;}
export function parseWorkspaceProjectCapabilities(value:unknown):WorkspaceProjectCapabilities;
export function parseWorkspaceProjectPoll(value:unknown):WorkspaceProjectPoll;
