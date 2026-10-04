import type {JsonValue, Permission, Scope} from './index.mjs';
import type {JobSnapshot, JobEvent} from './jobs.mjs';
import type {BinaryArtifact} from './artifacts.mjs';

export const JOB_STORAGE_VERSION: 1;
export const DEFAULT_JOB_RETENTION_MS: 86400000;
export const JOB_STORE_LIMITS: Readonly<{records:256;recordBytes:524288;storeBytes:67108864;retentionMs:604800000;pendingWrites:32}>;
export interface JobStoreLimits {readonly records:number;readonly recordBytes:524288;readonly storeBytes:number;readonly retentionMs:number;readonly pendingWrites:32;}
export interface JobStoreIdentity {readonly schemaVersion:1;readonly storeId:string;readonly workspaceId:string;readonly workspaceIdentity:string;}
export interface StoredJob extends JobStoreIdentity {
  readonly pluginArtifactSha256:string;readonly requestSha256:string;readonly revision:number;
  readonly savedAt:number;readonly expiresAt:number;readonly settled:boolean;
  readonly contentPolicy:'metadata-only'|'host-redacted';readonly grants:readonly Permission[];
  readonly snapshot:JobSnapshot;readonly events:readonly JobEvent[];readonly binaryArtifacts:readonly BinaryArtifact[];
  readonly attemptOf?:string;
}
/** Trusted host port. Open/load before use; get/has expose its bounded committed index. */
export interface JobStore {
  readonly identity:JobStoreIdentity;readonly limits:JobStoreLimits;
  has(jobId:string):boolean;
  get(jobId:string):StoredJob|null;
  entries():readonly StoredJob[];
  pin(jobId:string):()=>void;
  write(record:StoredJob,expectedRevision:number):Promise<StoredJob>;
  flush():Promise<void>;
}
export interface JobStorageOptions {
  readonly store:JobStore;
  /** Current operator-owned workspace identity, never taken from a remote request. */
  readonly workspaceIdentity:string;
  readonly pluginArtifacts:Readonly<Record<string,string>>;
  /** Default drops free-form messages/results. This trusted callback returns only reviewed safe data. */
  readonly redact?:(entry:{readonly kind:'log'|'progress'|'result';readonly value:JsonValue;readonly jobId:string;readonly pluginId:string;readonly commandId:string})=>JsonValue;
}
export interface JobStorageCapabilities {readonly protocolVersion:1;readonly enabled:boolean;readonly identity:JobStoreIdentity|null;readonly limits:JobStoreLimits;}
export type JobRecovery = {readonly protocolVersion:1;readonly jobId:string;readonly scope:Scope;readonly storeId:string;readonly unrecordedTail:'none'|'unknown'} & (
  {readonly disposition:'live'|'completed'|'interrupted';readonly record:StoredJob} |
  {readonly disposition:'expired'|'missing'|'corrupt'|'unsupported';readonly record:null});
export function parseJobStoreIdentity(value:unknown):JobStoreIdentity;
export function parseJobStoreLimits(value:unknown):JobStoreLimits;
export function parseStoredJob(value:unknown):StoredJob;
export function parseJobStorageCapabilities(value:unknown):JobStorageCapabilities;
export function parseJobRecovery(value:unknown):JobRecovery;
