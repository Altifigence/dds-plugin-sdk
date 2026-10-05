import type {Diagnostic} from './index.mjs';
import type {JobReporter} from './jobs.mjs';
export const TOOL_STREAM_LIMITS:Readonly<{chunkBytes:number;lineBytes:number;totalBytes:number;events:number;queuedWrites:number;eventTimeoutMs:number}>;
export type ToolStreamData = {readonly kind:'log';readonly level:'debug'|'info'|'warning'|'error';readonly message:string} | {readonly kind:'progress';readonly completed:number;readonly total:number;readonly message?:string} | ({readonly kind:'diagnostic';readonly path:string}&Diagnostic) | {readonly kind:'unknown';readonly reason:string;readonly message:string};
export interface ToolStreamEvent {readonly schemaVersion:1;readonly sequence:number;readonly jobId:string;readonly commandId:string;readonly toolId:string;readonly toolVersion:string;readonly stream:'stdout'|'stderr';readonly data:ToolStreamData;}
export interface ToolStreamStats {readonly bytes:number;readonly events:number;readonly unknown:number;readonly peakQueued:number;}
export interface ToolStreamParser {write(input:Uint8Array,stream?:'stdout'|'stderr'):Promise<void>;finish():Promise<ToolStreamStats>;dispose():void;inspect():ToolStreamStats & {readonly queued:number;readonly closed:boolean;readonly failed:boolean};}
export function parseToolStreamEvent(input:unknown):ToolStreamEvent;
export function parseTypeScriptDiagnosticLine(line:string):Extract<ToolStreamData,{kind:'diagnostic'}>|null;
export function createToolStreamParser(options:{readonly format?:'jsonl'|'text';readonly parser?:'plain'|'typescript';readonly jobId:string;readonly commandId:string;readonly toolId:string;readonly toolVersion:string;readonly onEvent:(event:ToolStreamEvent)=>void|Promise<void>;readonly secrets?:readonly string[];readonly sensitivePaths?:readonly string[];readonly signal?:AbortSignal;readonly maxLineBytes?:number;readonly maxTotalBytes?:number;readonly maxEvents?:number;readonly eventTimeoutMs?:number}):ToolStreamParser;
export function createJobToolEventSink(job:Pick<JobReporter,'reportProgress'|'log'>,options?:{readonly onDiagnostic?:(event:ToolStreamEvent)=>void|Promise<void>}):(event:ToolStreamEvent)=>Promise<void>;
