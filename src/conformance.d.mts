import type {PluginHost,PluginHostOptions} from './index.mjs';
import type {SettingsStore,SettingsDefinition} from './settings.mjs';
import type {WorkspaceClient} from './workspace-client.mjs';
import type {WorkspaceEditJournal} from './workspace-edits.mjs';
export type ConformanceFeature='commands'|'permissions'|'cancellation'|'language'|'language-editing'|'language-display'|'settings'|'jobs'|'storage-history'|'files'|'projects'|'artifacts'|'uploads-transfers'|'workspace-edits'|'localization'|'testing-replay'|'diagnostics'|'development-tools';
export interface ConformanceIdentity {readonly host:string;readonly version:string;readonly runtime:string;readonly platform:string;}
export interface ConformanceWorkspace {readonly client:WorkspaceClient;readonly artifactSha256:string;readonly journal:WorkspaceEditJournal;writeFixture(content:string):Promise<void>;restart():Promise<void>;revokeProjects():void;revokeUploads():void;dispose():Promise<void>;}
/** Each factory supplies an isolated fixture. No adapter may address a real user's workspace. */
export interface ConformanceAdapters {
  readonly host?:(options?:PluginHostOptions)=>PluginHost|Promise<PluginHost>;
  readonly settings?:(definition:SettingsDefinition)=>SettingsStore|Promise<SettingsStore>;
  readonly workspace?:(options:{readonly signal:AbortSignal})=>Promise<ConformanceWorkspace>;
  readonly localization?:Pick<typeof import('./localization.mjs'),'resolveMessage'>;
  readonly testing?:Pick<typeof import('./testing.mjs'),'createTestClock'|'createTestRecorder'|'createTestReplay'>;
  readonly diagnostics?:Pick<typeof import('./diagnostics.mjs'),'createDiagnosticSession'|'profileHost'>;
  readonly development?:()=>Promise<{readonly api:Pick<typeof import('./devtools.mjs'),'planPlugin'|'initPlugin'|'doctorPlugin'|'generatePluginContracts'>;readonly directory:string;dispose():Promise<void>}>;
}
export interface ConformanceOptions {readonly identity:ConformanceIdentity;readonly features:readonly string[];readonly requiredFeatures?:readonly ConformanceFeature[];readonly adapters:ConformanceAdapters;readonly timeoutMs?:number;readonly signal?:AbortSignal;}
export type ConformanceStatus='supported'|'unsupported'|'failed';
export type ConformanceReason='passed'|'not_declared'|'missing_adapter'|'assertion'|'provider_error'|'timed_out'|'cancelled'|'cleanup_failed'|'aborted_after_timeout';
export interface ConformanceResult {readonly id:ConformanceFeature;readonly status:ConformanceStatus;readonly reason:ConformanceReason;readonly check:string|null;readonly durationMs:number;readonly cleanup:'complete'|'pending'|'failed'|'not-run';}
export interface ConformanceReport {readonly schemaVersion:1;readonly suiteVersion:1;readonly sdkVersion:string;readonly identity:ConformanceIdentity;readonly declaredFeatures:readonly string[];readonly unknownFeatures:readonly string[];readonly requiredFeatures:readonly ConformanceFeature[];readonly results:readonly ConformanceResult[];readonly summary:Readonly<Record<ConformanceStatus,number>>;readonly ok:boolean;}
export const CONFORMANCE_CASES:readonly {readonly id:ConformanceFeature;readonly since:string;readonly port:keyof ConformanceAdapters;readonly required:boolean;readonly fixture:string}[];
export const CONFORMANCE_FEATURES:readonly ConformanceFeature[];
export const CONFORMANCE_LIMITS:Readonly<{features:64;timeoutMs:30000;reportBytes:65536}>;
export function runConformance(options:ConformanceOptions):Promise<ConformanceReport>;
export function parseConformanceReport(input:unknown):ConformanceReport;
export function formatConformanceReport(input:ConformanceReport):string;
