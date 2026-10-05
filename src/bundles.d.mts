import type {VerifiedPluginArchive} from './publishing.mjs';
export interface BundleFile {readonly path:string; readonly data:string;}
export interface BundleDependencyInput {
  readonly name:string; readonly version:string; readonly source:string; readonly entry:string; readonly type:'module'|'commonjs';
  readonly dependencies:Readonly<Record<string,string>>; readonly license:string; readonly licenseFile:string; readonly noticeFile:string|null;
  readonly redistributable:true; readonly files:readonly BundleFile[];
}
export interface LockedBundleDependency extends BundleDependencyInput {readonly sha256:string;}
export interface PluginBundleInput {
  readonly plugin:{readonly archive:string; readonly metadata:unknown; readonly sha256:string};
  readonly dependencies:Readonly<Record<string,string>>; readonly packages:readonly LockedBundleDependency[];
}
export interface BundleReceipt {
  readonly schemaVersion:1; readonly sha256:string; readonly checksumPinned:boolean; readonly plugin:VerifiedPluginArchive;
  readonly dependencies:readonly (Omit<LockedBundleDependency,'files'> & {readonly files:readonly {readonly path:string;readonly size:number;readonly sha256:string}[]})[];
  readonly fileCount:number; readonly unpackedBytes:number; readonly sbom:Readonly<Record<string,unknown>>; readonly executionAuthorized:false;
}
export const BUNDLE_LIMITS:Readonly<{packages:32;files:1024;fileBytes:number;unpackedBytes:number;bundleBytes:number}>;
export function lockBundleDependency(input:BundleDependencyInput):LockedBundleDependency;
export function createPluginBundle(input:PluginBundleInput):Uint8Array;
export function verifyPluginBundle(bytes:Uint8Array,options?:{readonly expectedSha256?:string}):BundleReceipt;
export function installPluginBundle(bytes:Uint8Array,options:{readonly destination:string;readonly expectedSha256:string;readonly approved:true}):Promise<BundleReceipt & {readonly destination:string;readonly installed:true;readonly lifecycleScriptsRun:false;readonly networkUsed:false}>;
