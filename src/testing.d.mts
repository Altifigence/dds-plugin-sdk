import type { Permission, PluginHost, Scope,HostRuntime,Disposable,WorkspacePort,JsonValue,HostId,HostInspection } from './index.mjs';
import type {SettingsDefinition,SettingsStore} from './settings.mjs';
import type {SecretResolver} from './secrets.mjs';
import type {ProjectSnapshot} from './project-watch.mjs';
import type {JobStorageOptions,JobStore,JobStoreIdentity,StoredJob} from './job-storage.mjs';

export interface TestHost extends PluginHost {}
/** Runs trusted local modules in-process; this developer host is not a sandbox. */
export function createTestHost(options?: {readonly scope?: Scope; readonly grants?: readonly Permission[]}): TestHost;
export const TEST_LIMITS:Readonly<{timers:4096;steps:10000;pending:64;faults:256;files:256;fileBytes:262144;workspaceBytes:4194304;traceEvents:1024;traceBytes:1048576;resources:1024}>;
export interface TestClock extends Disposable {readonly seed:number;readonly runtime:HostRuntime;now():number;advance(ms:number,options?:{readonly maxSteps?:number}):Promise<{readonly now:number;readonly timers:number;readonly steps:number}>;runUntilIdle(options?:{readonly maxSteps?:number}):Promise<{readonly now:number;readonly timers:number;readonly steps:number}>;inspect():Readonly<{now:number;timers:number;disposed:boolean}>;}
/** Only the mounted runtime is virtual. SDK I/O, arbitrary plugins and OS processes remain real. */
export function createTestClock(options?:{readonly seed?:number;readonly start?:number}):TestClock;
export function flushTestMicrotasks(turns?:number):Promise<void>;
export type TestResourceKind='file-handle'|'process'|'subscription'|'timer'|'operation';
export const TEST_RESOURCE_KINDS:readonly TestResourceKind[];
export interface TestResources {track(kind:TestResourceKind,dispose:()=>void|Promise<void>):{release():Promise<void>};inspect():Readonly<Record<TestResourceKind,number>>;assertEmpty():void;dispose():Promise<void>;}
export function createTestResources():TestResources;
export type TestFault={readonly operation:string}&({readonly kind:'delay';readonly delayMs:number}|{readonly kind:'corrupt';readonly value:JsonValue}|{readonly kind:'deny'|'disconnect'|'drop'|'exhaust'});
export const TEST_FAULTS:readonly TestFault['kind'][];
export interface FaultController extends Disposable {enqueue(fault:TestFault):void;invoke<T>(operation:string,callback:(signal:AbortSignal)=>T|Promise<T>,options?:{readonly signal?:AbortSignal}):Promise<T|JsonValue>;events(values:readonly JsonValue[],options?:{readonly drop?:number;readonly duplicate?:number;readonly reverse?:boolean}):readonly JsonValue[];inspect():Readonly<{queued:number;pending:number}>;}
export function createFaultController(runtime?:HostRuntime):FaultController;
export interface MemoryWorkspace extends Disposable {readonly port:Required<WorkspacePort>;snapshot(root?:string):ProjectSnapshot;subscribe(root:string,callback:(snapshot:ProjectSnapshot)=>void|Promise<void>):Disposable;setFile(path:string,content:string|Uint8Array):void;removeFile(path:string):boolean;inspect():Readonly<{files:number;bytes:number;subscriptions:number;handles:number}>;}
export function createMemoryWorkspace(options?:{readonly files?:Readonly<Record<string,string|Uint8Array>>;readonly runtime?:HostRuntime;readonly faults?:FaultController;readonly authorize?:(permission:'read'|'write')=>boolean}):MemoryWorkspace;
export interface MemoryJobSnapshot {readonly schemaVersion:1;readonly identity:JobStoreIdentity;readonly records:readonly StoredJob[];readonly sha256:string;}
export interface MemoryJobStore extends JobStore,Disposable {snapshot():MemoryJobSnapshot;markUnavailable(jobId:string,kind:'corrupt'|'unsupported'):void;inspect():Readonly<{records:number;bytes:number;pins:number;pending:number}>;}
export function createMemoryJobStore(options:{readonly identity:JobStoreIdentity;readonly snapshot?:MemoryJobSnapshot;readonly faults?:FaultController}):MemoryJobStore;
export interface ScenarioOptions {readonly seed?:number;readonly start?:number;readonly hostId?:HostId;readonly scope?:Scope;readonly grants?:readonly Permission[];readonly files?:Readonly<Record<string,string|Uint8Array>>;readonly backends?:Readonly<Record<string,JsonValue>>;readonly settings?:readonly SettingsDefinition[];readonly secrets?:Readonly<Record<string,Uint8Array>>;readonly jobs?:boolean;readonly binaryArtifacts?:boolean;readonly jobStorage?:JobStorageOptions;}
export interface ScenarioInspection {readonly host:HostInspection;readonly clock:ReturnType<TestClock['inspect']>;readonly faults:ReturnType<FaultController['inspect']>;readonly workspace:ReturnType<MemoryWorkspace['inspect']>|null;readonly settings:Readonly<Record<string,ReturnType<SettingsStore['inspect']>>>;readonly secrets:ReturnType<SecretResolver['inspect']>|null;readonly resources:ReturnType<TestResources['inspect']>;}
export interface ScenarioHost {readonly host:PluginHost;readonly clock:TestClock;readonly faults:FaultController;readonly workspace:MemoryWorkspace|null;readonly settings:Readonly<Record<string,SettingsStore>>;readonly secrets:SecretResolver|null;readonly resources:TestResources;readonly capabilities:Readonly<{workspace:boolean;backends:readonly string[];settings:readonly string[];secrets:boolean;jobs:boolean;binaryArtifacts:boolean}>;replaceGrants(grants:readonly Permission[]):void;inspect():ScenarioInspection;assertClean():void;dispose():Promise<void>;}
export function createScenarioHost(options?:ScenarioOptions):ScenarioHost;
export type TraceOperation='command'|'language'|'workspace'|'project'|'job'|'binary'|'settings'|'secret'|'backend';
export const TRACE_OPERATIONS:readonly TraceOperation[];
export interface TestFixture {readonly id:string;readonly operation:TraceOperation;readonly input:JsonValue;readonly output:JsonValue;}
export interface TestTraceEvent {readonly sequence:number;readonly at:number;readonly fixtureId:string;readonly operation:TraceOperation;readonly inputSha256:string;readonly outputSha256:string;readonly previousSha256:string;readonly sha256:string;}
export interface TestTrace {readonly schemaVersion:1;readonly seed:number;readonly fixtureVersion:number;readonly fixtureDigest:string;readonly events:readonly TestTraceEvent[];readonly digest:string;}
export interface TestTraceOptions {readonly synthetic:true;readonly seed:number;readonly fixtureVersion:number;readonly fixtures:readonly TestFixture[];}
export interface TestRecorder extends Disposable {record(fixtureId:string,input:JsonValue,output:JsonValue):TestTraceEvent;snapshot():TestTrace;}
export interface TestReplay extends Disposable {next(fixtureId:string,input:JsonValue):JsonValue;inspect():Readonly<{position:number;remaining:number}>;assertComplete():void;}
export function parseTestTrace(input:unknown):TestTrace;
export function createTestRecorder(options:TestTraceOptions & {readonly now?:()=>number}):TestRecorder;
export function createTestReplay(trace:TestTrace,options:TestTraceOptions):TestReplay;
