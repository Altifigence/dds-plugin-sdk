import type {JsonValue} from './index.mjs';
export interface DoctorCheck {readonly id:string;readonly status:'pass'|'warning'|'error';readonly message:string;readonly fix?:string;}
export interface DoctorReport {readonly ok:boolean;readonly directory:string;readonly checks:readonly DoctorCheck[];}
export function initPlugin(directory:string, options?:{readonly id?:string;readonly publisher?:string;readonly name?:string}):Promise<{readonly directory:string;readonly pluginId:string;readonly sdkVersion:string;readonly files:readonly string[];readonly next:readonly string[]}>;
export function doctorPlugin(directory:string):Promise<DoctorReport>;
export type DevEvent = {readonly type:'start';readonly run:number;readonly pid:number|undefined} | {readonly type:'output';readonly stream:'stdout'|'stderr';readonly text:string} | {readonly type:'validation';readonly ok:false;readonly checks:readonly DoctorCheck[]} | {readonly type:'complete'|'timeout';readonly run:number;readonly ok:boolean};
export function runPluginDev(directory:string, options:{readonly trustLocalCode:true;readonly watch?:boolean;readonly command?:string;readonly input?:JsonValue;readonly job?:boolean;readonly timeoutMs?:number;readonly signal?:AbortSignal;readonly onEvent?:(event:DevEvent)=>void}):Promise<{readonly ok:boolean;readonly runs:number;readonly stopped:boolean}>;
