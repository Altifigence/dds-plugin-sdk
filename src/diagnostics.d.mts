import type {PluginHost,Disposable,ErrorCode as ErrorCodes} from './index.mjs';
export type DiagnosticErrorCode=typeof ErrorCodes[keyof typeof ErrorCodes];
export type DiagnosticOperation='activation'|'command'|'language'|'transport'|'workspace'|'project'|'job'|'binary'|'settings'|'secret'|'backend'|'dispose';
export type DiagnosticResource='plugins'|'commands'|'registrations'|'pendingActivations'|'pendingOperations'|'providerOperations'|'pendingJobs'|'binaryOperations'|'pendingCheckpoints'|'retainedJobs'|'resolveTokens'|'semanticEntries'|'timers'|'subscriptions'|'fileHandles'|'processes'|'memoryBytes';
export type DiagnosticStatus='ok'|'cancelled'|'error'|'disposed';
export const DIAGNOSTIC_OPERATIONS:readonly DiagnosticOperation[];
export const DIAGNOSTIC_RESOURCES:readonly DiagnosticResource[];
export const DIAGNOSTIC_LIMITS:Readonly<{events:256;pending:64;exportBytes:262144;retentionMs:300000;sampleEvery:1000;count:1000000000000}>;
export interface DiagnosticStart {readonly parentId?:string;readonly inputBytes?:number;readonly queueDepth?:number;}
export interface DiagnosticEnd {readonly status?:DiagnosticStatus;readonly errorCode?:DiagnosticErrorCode;readonly outputBytes?:number;readonly resources?:Readonly<Partial<Record<DiagnosticResource,number>>>;}
export interface DiagnosticSpan {readonly id:string|null;end(metadata?:DiagnosticEnd):void;}
export interface DiagnosticEvent {readonly id:string;readonly parentId:string|null;readonly operation:DiagnosticOperation;readonly startedAt:number;readonly durationMs:number;readonly status:DiagnosticStatus;readonly errorCode?:DiagnosticErrorCode;readonly inputBytes:number|null;readonly outputBytes:number|null;readonly queueDepth:number|null;readonly resources:Readonly<Partial<Record<DiagnosticResource,number>>>;}
export interface DiagnosticReport {readonly schemaVersion:1;readonly enabled:boolean;readonly sampleEvery:number;readonly retentionMs:number;readonly capacity:number;readonly attempted:number;readonly sampled:number;readonly dropped:number;readonly pending:number;readonly events:readonly DiagnosticEvent[];}
export interface DiagnosticSession extends Disposable {readonly enabled:boolean;begin(operation:DiagnosticOperation,metadata?:DiagnosticStart):DiagnosticSpan;measure<T>(operation:DiagnosticOperation,callback:(id:string|null)=>T,metadata?:DiagnosticStart):T;snapshot():DiagnosticReport;clear():void;}
export function createDiagnosticSession(options?:{readonly enabled?:boolean;readonly now?:()=>number;readonly sampleEvery?:number;readonly retentionMs?:number;readonly capacity?:number}):DiagnosticSession;
export function parseDiagnosticReport(input:unknown):DiagnosticReport;
export function profileHost(host:PluginHost,session:DiagnosticSession):PluginHost;
export function profileTransport<F extends (...args:any[])=>any>(transport:F,session:DiagnosticSession):F;
