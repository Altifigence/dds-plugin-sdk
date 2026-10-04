import type {JsonValue, PluginManifest, CommandDefinition} from './index.mjs';
import type {SettingsDefinition} from './settings.mjs';
import type {LocaleCatalog} from './localization.mjs';
import type {DdsTheme} from './themes.mjs';
export type PluginTemplate = 'command'|'language'|'theme'|'job'|'browser'|'configuration';
export const PLUGIN_TEMPLATES: readonly PluginTemplate[];
export const DEVTOOLS_LIMITS: Readonly<{definitionBytes:262144;commands:64;generatedFiles:256;generatedBytes:4194304}>;
export interface DevelopmentDefinition {readonly schemaVersion:1;readonly template:PluginTemplate;readonly commands:readonly CommandDefinition[];readonly settings?:SettingsDefinition;readonly catalog?:LocaleCatalog;readonly theme?:DdsTheme;}
export function parseDevelopmentDefinition(input:unknown,manifest?:PluginManifest):DevelopmentDefinition;
export interface InitPluginOptions {readonly id?:string;readonly publisher?:string;readonly name?:string;readonly template?:PluginTemplate;readonly license?:'Apache-2.0'|'LicenseRef-Proprietary';readonly licenseFile?:string;readonly dryRun?:boolean;}
export interface GeneratedFile {readonly path:string;readonly bytes:number;readonly sha256:string;}
export interface PluginPlan {readonly schemaVersion:1;readonly directory:string;readonly pluginId:string;readonly template:PluginTemplate;readonly sdkVersion:string;readonly generationDigest:string;readonly files:readonly GeneratedFile[];readonly conflicts:readonly {readonly path:'.';readonly reason:'destination_exists'}[];readonly writes:false;}
export interface InitializedPlugin {readonly directory:string;readonly pluginId:string;readonly template:PluginTemplate;readonly sdkVersion:string;readonly generationDigest:string;readonly files:readonly string[];readonly next:readonly string[];}
export function planPlugin(directory:string,options?:InitPluginOptions):Promise<PluginPlan>;
export interface GenerationReport {readonly schemaVersion:1;readonly directory:string;readonly sdkVersion:string;readonly digest:string;readonly previousDigest:string|null;readonly current:boolean;readonly written:boolean;readonly files:readonly GeneratedFile[];readonly conflicts:readonly string[];readonly ok?:boolean;}
export function generatePluginContracts(directory:string,options?:{readonly dryRun?:boolean;readonly check?:boolean;readonly expectedDigest?:string}):Promise<GenerationReport>;
export interface DoctorCheck {readonly id:string;readonly status:'pass'|'warning'|'error';readonly message:string;readonly fix?:string;}
export interface DoctorReport {readonly ok:boolean;readonly directory:string;readonly checks:readonly DoctorCheck[];}
export function initPlugin(directory:string, options:InitPluginOptions & {readonly dryRun:true}):Promise<PluginPlan>;
export function initPlugin(directory:string, options?:InitPluginOptions & {readonly dryRun?:false}):Promise<InitializedPlugin>;
export function initPlugin(directory:string, options:InitPluginOptions):Promise<InitializedPlugin|PluginPlan>;
export function doctorPlugin(directory:string):Promise<DoctorReport>;
export type DevEvent = {readonly type:'start';readonly run:number;readonly pid:number|undefined} | {readonly type:'output';readonly stream:'stdout'|'stderr';readonly text:string} | {readonly type:'validation';readonly ok:false;readonly checks:readonly DoctorCheck[]} | {readonly type:'complete'|'timeout';readonly run:number;readonly ok:boolean} | {readonly type:'debug';readonly run:number;readonly pid:number|undefined;readonly url:string;readonly expiresInMs:number} | {readonly type:'profile';readonly run:number;readonly report:import('./diagnostics.mjs').DiagnosticReport};
export function runPluginDev(directory:string, options:{readonly trustLocalCode:true;readonly watch?:boolean;readonly command?:string;readonly input?:JsonValue;readonly job?:boolean;readonly timeoutMs?:number;readonly profile?:boolean;readonly debug?:boolean;readonly debugWait?:boolean;readonly signal?:AbortSignal;readonly onEvent?:(event:DevEvent)=>void}):Promise<{readonly ok:boolean;readonly runs:number;readonly stopped:boolean}>;
