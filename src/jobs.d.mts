import type {JsonValue, Scope, PluginErrorCode} from './index.mjs';
import type {BinaryArtifact} from './artifacts.mjs';
export const JOB_PROTOCOL_VERSION: 1;
export const JOB_LIMITS: Readonly<{concurrent:number;retained:number;operations:number;events:number;eventBytes:number;messageBytes:number;artifacts:number;defaultTimeoutMs:number;maxTimeoutMs:number;retentionMs:number;pageSize:number}>;
export type JobState = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export const JOB_STATES: readonly JobState[];
export interface JobOptions {readonly jobId: string; readonly timeoutMs?: number;}
export interface JobProgress {readonly completed: number; readonly total: number; readonly message?: string;}
export interface JobArtifact {readonly id:string;readonly path:string;readonly revision:string;readonly byteLength:number;readonly label?:string;}
export interface JobReporter {
  reportProgress(progress: JobProgress): void;
  log(level: 'debug'|'info'|'warning'|'error', message: string): void;
  addArtifact(artifact: {readonly id:string;readonly path:string;readonly label?:string}): Promise<JobArtifact>;
  addBinaryArtifact(artifact: {readonly id:string;readonly path:string;readonly label?:string}): Promise<BinaryArtifact>;
  invokeBackend(id: string, input: JsonValue): Promise<JsonValue>;
}
export type JobEvent = {readonly sequence:number;readonly at:number} & (
  {readonly kind:'progress';readonly data:JobProgress} | {readonly kind:'artifact';readonly data:JobArtifact} |
  {readonly kind:'state';readonly data:{readonly state:JobState}} |
  {readonly kind:'log';readonly data:{readonly level:'debug'|'info'|'warning'|'error';readonly message:string}});
interface JobBase {readonly protocolVersion:1;readonly jobId:string;readonly scope:Scope;readonly pluginId:string;readonly commandId:string;readonly startedAt:number;readonly updatedAt:number;readonly timeoutMs:number;readonly progress:JobProgress|null;readonly artifacts:readonly JobArtifact[];readonly lastSequence:number;}
export type JobSnapshot = JobBase & ({readonly state:'running';readonly result?:never;readonly error?:never} | {readonly state:'succeeded';readonly result:JsonValue;readonly error?:never} | {readonly state:'failed'|'cancelled'|'timed_out';readonly error:{readonly code:PluginErrorCode};readonly result?:never});
export interface JobEvents {readonly jobId:string;readonly scope:Scope;readonly after:number;readonly nextCursor:number;readonly dropped:number;readonly hasMore:boolean;readonly events:readonly JobEvent[];}
export interface JobArtifactContent {readonly jobId:string;readonly scope:Scope;readonly artifact:JobArtifact;readonly content:string;}
export interface JobCapabilities {readonly protocolVersion:1;readonly enabled:boolean;readonly limits:typeof JOB_LIMITS;}
export function parseJobId(value:unknown):string;
export function parseJobOptions(value:unknown):Required<JobOptions>;
export function parseJobProgress(value:unknown):JobProgress;
export function parseJobArtifact(value:unknown):JobArtifact;
export function parseJobEvent(value:unknown):JobEvent;
export function parseJobSnapshot(value:unknown):JobSnapshot;
export function parseJobEvents(value:unknown):JobEvents;
export function parseJobCapabilities(value:unknown):JobCapabilities;
export function parseJobArtifactContent(value:unknown):JobArtifactContent;
