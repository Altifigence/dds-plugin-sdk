import type {ProvenanceEnvelope,ProvenancePolicy} from './provenance.mjs';
export interface UpdateArtifact {readonly bundle:Uint8Array;readonly envelope:ProvenanceEnvelope|null;}
export interface UpdateDescriptor {readonly schemaVersion:1;readonly bundleSha256:string;readonly name:string;readonly publisher:string;readonly pluginId:string;readonly version:string;readonly api:Readonly<Record<string,unknown>>;readonly grants:readonly string[];readonly dependencies:readonly {readonly name:string;readonly version:string;readonly sha256:string;readonly source:string}[];readonly tools:readonly unknown[];readonly licenses:readonly Readonly<Record<string,unknown>>[];readonly settingsSha256:string;readonly provenanceSha256:string;readonly keyId:string|null;}
export interface UpdateMigration {readonly id:string;readonly reversible:boolean;}
export interface PluginUpdatePlan {readonly schemaVersion:1;readonly current:UpdateDescriptor;readonly candidate:UpdateDescriptor;readonly migration:UpdateMigration;readonly jobPolicy:'wait'|'retain-old';readonly changes:Readonly<Record<string,boolean>>;readonly externalEffectsUndone:false;readonly sha256:string;}
export interface PluginUpdateRecord {readonly schemaVersion:1;readonly revision:number;readonly activeSha256:string;readonly settingsSha256:string;readonly phase:'idle'|'staged'|'approved'|'preparing'|'activated'|'failed';readonly plan:PluginUpdatePlan|null;readonly disposition:string;}
export interface PluginUpdateJournal {read():Promise<PluginUpdateRecord|null>;compareAndSwap(expectedRevision:number,next:PluginUpdateRecord):Promise<PluginUpdateRecord>;}
export interface UpdateHost {execute(input:unknown,context:{readonly settings:unknown;readonly signal?:AbortSignal;readonly pluginSha256:string}):unknown|Promise<unknown>;dispose():void|Promise<void>;}
export interface PluginUpdateController {
  inspect():{record:PluginUpdateRecord;current:UpdateDescriptor;pending:{plan:PluginUpdatePlan;approved:boolean}|null;jobs:number;retired:{sha256:string;jobs:number}[];disposed:boolean;uncertain:boolean};
  stage(input:{readonly candidate:UpdateArtifact;readonly nextSettings:unknown;readonly migration:UpdateMigration;readonly jobPolicy:'wait'|'retain-old'}):Promise<PluginUpdatePlan>;
  approve(input:{readonly sha256:string;readonly grants:readonly string[];readonly keyId:string|null;readonly approved:true}):Promise<PluginUpdateRecord>;
  activate(input:{readonly sha256:string;readonly signal?:AbortSignal}):Promise<PluginUpdateRecord & {cleanupFailed:boolean;externalEffectsUndone:false}>;
  execute(input:unknown,options?:{readonly signal?:AbortSignal}):Promise<{pluginSha256:string;result:unknown}>;
  replaceSettings(expectedSha256:string,nextSettings:unknown):Promise<string>;
  discard():Promise<void>;dispose():Promise<void>;
}
export function createPluginUpdatePlan(input:{readonly current:UpdateArtifact;readonly candidate:UpdateArtifact;readonly settings:unknown;readonly nextSettings:unknown;readonly migration:UpdateMigration;readonly jobPolicy:'wait'|'retain-old'}):PluginUpdatePlan;
export function parsePluginUpdatePlan(value:unknown):PluginUpdatePlan;
export function createMemoryUpdateJournal():PluginUpdateJournal;
export function reconcilePluginUpdateJournal(journal:PluginUpdateJournal,input:{readonly expectedRevision:number;readonly activeSha256:string;readonly settingsSha256:string;readonly approved:true}):Promise<PluginUpdateRecord>;
export function createPluginUpdateController(options:{readonly initial:UpdateArtifact;readonly initialHost:UpdateHost;readonly settings:unknown;readonly getPolicy:(descriptor:UpdateDescriptor,envelope:ProvenanceEnvelope|null)=>ProvenancePolicy|Promise<ProvenancePolicy>;readonly prepare:(bundle:Uint8Array,context:{readonly settings:unknown;readonly grants:readonly string[];readonly signal?:AbortSignal})=>UpdateHost|Promise<UpdateHost>;readonly journal:PluginUpdateJournal}):Promise<PluginUpdateController>;
