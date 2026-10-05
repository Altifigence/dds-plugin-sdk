import type {JsonValue, PluginHost, Scope} from './index.mjs';
import type {DataSchema} from './data-schema.mjs';
import type {JobArtifact} from './jobs.mjs';
export const WORKFLOW_LIMITS: Readonly<{steps:number;concurrency:number;planBytes:number;recordBytes:number;valueBytes:number;outputBytes:number;timeoutMs:number;retentionMs:number;records:number}>;
export interface WorkflowScope {readonly workspaceId:string;readonly securityScope:string;}
export interface WorkflowCommand {readonly id:string;readonly pluginId:string;readonly pluginSha256:string;readonly inputSchema:DataSchema;readonly outputSchema:DataSchema;readonly grants:readonly string[];}
export type WorkflowBinding = {readonly value:JsonValue;readonly step?:never;readonly path?:never} | {readonly step:string;readonly path:readonly string[];readonly value?:never};
export interface WorkflowStep {readonly id:string;readonly commandId:string;readonly needs:readonly string[];readonly input:Readonly<Record<string,WorkflowBinding>>;readonly grants:readonly string[];}
export interface WorkflowDefinition {readonly schemaVersion:1;readonly id:string;readonly scope:WorkflowScope;readonly steps:readonly WorkflowStep[];readonly policy:'fail-fast'|'continue';readonly concurrency:number;readonly timeoutMs:number;readonly stepTimeoutMs:number;readonly retentionMs:number;}
export interface WorkflowPlan {readonly schemaVersion:1;readonly definition:WorkflowDefinition;readonly commands:readonly WorkflowCommand[];readonly sha256:string;}
export type WorkflowState = 'pending'|'running'|'succeeded'|'failed'|'cancelled'|'timed_out'|'blocked'|'interrupted';
export interface WorkflowCacheEvidence {readonly state:'hit'|'miss'|'shared'|'bypass';readonly key:string;readonly reason:string;}
export interface WorkflowStepRecord {readonly id:string;readonly commandId:string;readonly state:WorkflowState;readonly jobId:string|null;readonly sourceAttemptId:string|null;readonly inputSha256:string|null;readonly output:JsonValue;readonly outputSha256:string|null;readonly artifacts:readonly JobArtifact[];readonly cache:WorkflowCacheEvidence|null;readonly reason:string|null;readonly startedAt:number|null;readonly finishedAt:number|null;}
export interface WorkflowRecord {readonly schemaVersion:1;readonly workflowId:string;readonly attemptId:string;readonly parentAttemptId:string|null;readonly parentJobId:string|null;readonly planSha256:string;readonly scope:WorkflowScope;readonly revision:number;readonly state:WorkflowState;readonly startedAt:number;readonly updatedAt:number;readonly expiresAt:number;readonly steps:readonly WorkflowStepRecord[];}
export interface WorkflowStore {read(id:string):Promise<WorkflowRecord|null>;write(record:WorkflowRecord,expectedRevision:number):Promise<void>;list():Promise<readonly WorkflowRecord[]>;}
export interface WorkflowApproval {readonly approved:true;readonly planSha256:string;readonly previousAttemptId?:string;readonly retrySteps?:readonly string[];}
export interface WorkflowAuthorization {readonly scope:WorkflowScope;readonly command:WorkflowCommand;readonly grants:readonly string[];readonly stepId:string;readonly phase:'before'|'after'|'reuse';}
export type WorkflowExecutor = (step:WorkflowStep,command:WorkflowCommand,input:JsonValue,context:{readonly signal:AbortSignal;readonly jobId:string;readonly attemptId:string;readonly scope:WorkflowScope}) => {readonly output:JsonValue;readonly artifacts?:readonly JobArtifact[];readonly cache?:WorkflowCacheEvidence} | Promise<{readonly output:JsonValue;readonly artifacts?:readonly JobArtifact[];readonly cache?:WorkflowCacheEvidence}>;
export interface WorkflowRunner {inspect():Readonly<{running:boolean;unsettled:number}>;recover(attemptId:string):Promise<WorkflowRecord|null>;run(plan:WorkflowPlan,options:{readonly approval:WorkflowApproval;readonly previous?:WorkflowRecord|null;readonly parentJobId?:string|null;readonly signal?:AbortSignal}):Promise<WorkflowRecord>;}
export function parseWorkflowDefinition(input:unknown):WorkflowDefinition;
export function prepareWorkflowPlan(input:WorkflowDefinition,commands:readonly WorkflowCommand[]):WorkflowPlan;
export function parseWorkflowRecord(input:unknown):WorkflowRecord;
export function recoverWorkflowRecord(input:WorkflowRecord):WorkflowRecord;
export function createMemoryWorkflowStore(options?:{readonly maxRecords?:number}):WorkflowStore;
export function createWorkflowRunner(options:{readonly commands:readonly WorkflowCommand[];readonly execute:WorkflowExecutor;readonly authorize:(context:WorkflowAuthorization)=>boolean|Promise<boolean>;readonly store?:WorkflowStore;readonly now?:()=>number}):WorkflowRunner;
export function createCommandJobExecutor(options:{readonly resolveHost:(context:{readonly step:WorkflowStep;readonly command:WorkflowCommand;readonly grants:readonly string[];readonly scope:WorkflowScope})=>{readonly host:PluginHost;readonly scope:Scope;readonly grants:readonly string[];readonly pluginSha256:string}|Promise<{readonly host:PluginHost;readonly scope:Scope;readonly grants:readonly string[];readonly pluginSha256:string}>;readonly pollMs?:number}):WorkflowExecutor;
