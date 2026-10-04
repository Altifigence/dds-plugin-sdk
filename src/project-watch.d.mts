export const PROJECT_WATCH_LIMITS:Readonly<{observers:4;nativeHandles:128;entries:1000;visited:10000;depth:32;patterns:16;patternLength:256;fileBytes:16777216;scanBytes:67108864;snapshotBytes:131072;changes:256;queue:4;minIntervalMs:250;maxIntervalMs:60000;defaultIntervalMs:1000;minDebounceMs:10;maxDebounceMs:1000;defaultDebounceMs:50;maxScanMs:30000}>;
export type ProjectScanReason='entry_limit'|'visit_limit'|'depth_limit'|'file_bytes'|'scan_bytes'|'snapshot_bytes'|'scan_timeout'|'unsafe_entries'|'unstable';
export type ProjectResyncReason='initial_changed'|'scan_changed'|'scan_incomplete'|'scan_recovered'|'native_unavailable'|'native_unknown'|'native_overflow'|'watcher_limit'|'consumer_overflow'|'change_limit'|'cursor_gap'|'revision_mismatch';
export const PROJECT_SCAN_REASONS:readonly ProjectScanReason[];
export const PROJECT_RESYNC_REASONS:readonly ProjectResyncReason[];
export interface ProjectWatchCapabilities {readonly version:1;readonly supported:true;readonly platform:'win32'|'linux';readonly fileSystem:'local';readonly filesystemType:string;readonly mode:'native-hints-with-reconciliation';readonly rename:'delete-create';readonly roots:readonly string[];readonly limits:typeof PROJECT_WATCH_LIMITS;}
export interface ProjectWatchOptions {readonly root:string;readonly include?:readonly string[];readonly exclude?:readonly string[];readonly maxDepth?:number;readonly maxEntries?:number;readonly maxFileBytes?:number;readonly maxScanBytes?:number;readonly scanTimeoutMs?:number;readonly intervalMs?:number;readonly debounceMs?:number;}
export interface ProjectEntry {readonly path:string;readonly kind:'file'|'directory';readonly size:number;/** Content SHA-256, or null when this entry was not fully hashed. */readonly revision:string|null;/** Full content hash when revision is present; otherwise opaque metadata identity. */readonly fingerprint:string;}
export interface ProjectSnapshot {readonly version:1;readonly root:string;readonly revision:string;readonly entries:readonly ProjectEntry[];readonly complete:boolean;readonly reasons:readonly ProjectScanReason[];readonly observedAt:number;}
export interface ProjectChange {readonly kind:'created'|'changed'|'deleted';readonly path:string;readonly previous:ProjectEntry|null;readonly current:ProjectEntry|null;}
export interface ProjectWatchEvent {readonly version:1;readonly subscriptionId:string;readonly cursor:number;readonly kind:'snapshot'|'changes'|'resync';readonly previousRevision:string|null;readonly snapshot:ProjectSnapshot;readonly changes:readonly ProjectChange[];readonly reason:ProjectResyncReason|null;}
export function parseProjectPatterns(value:unknown):readonly string[];
export function parseProjectWatchOptions(value:unknown):Readonly<Required<ProjectWatchOptions>>;
export function parseProjectEntry(value:unknown):ProjectEntry;
export function parseProjectSnapshot(value:unknown):ProjectSnapshot;
export function parseProjectWatchEvent(value:unknown):ProjectWatchEvent;
export function parseProjectWatchCapabilities(value:unknown):ProjectWatchCapabilities;
