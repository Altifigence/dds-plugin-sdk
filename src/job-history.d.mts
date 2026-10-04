import type {Scope} from './index.mjs';
import type {JobState} from './jobs.mjs';
export const JOB_HISTORY_LIMITS: Readonly<{pageSize:32;snapshots:8;cursorMs:60000;records:256}>;
export type JobHistoryDisposition = 'live'|'completed'|'interrupted'|'expired';
export interface JobHistoryQuery {readonly limit?:number;readonly state?:JobState;readonly disposition?:JobHistoryDisposition;readonly commandId?:string;readonly from?:number;readonly to?:number;readonly attemptOf?:string;readonly cursor?:string;}
export interface JobHistoryItem {
  readonly jobId:string;readonly commandId:string;readonly state:JobState;readonly disposition:JobHistoryDisposition;
  readonly startedAt:number;readonly updatedAt:number;readonly expiresAt:number;readonly revision:number;readonly attemptOf:string|null;
  readonly contentPolicy:'metadata-only'|'host-redacted';readonly artifactCount:number;readonly resultAvailability:'none'|'source-references'|'expired';
}
export interface JobHistoryPage {
  readonly protocolVersion:1;readonly scope:Scope;readonly storeId:string;readonly pluginId:string;readonly pluginArtifactSha256:string;
  readonly asOf:number;readonly expiresAt:number;readonly items:readonly JobHistoryItem[];readonly nextCursor:string|null;
}
export function parseJobHistoryQuery(value?:unknown):JobHistoryQuery & {readonly limit:number};
export function parseJobHistoryItem(value:unknown):JobHistoryItem;
export function parseJobHistoryPage(value:unknown):JobHistoryPage;
