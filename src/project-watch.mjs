import {copyWorkspaceJson, exactObject, requireWorkspacePath, requireSha256, requireUuid, workspaceFailure} from './workspace-values.mjs';

export const PROJECT_WATCH_LIMITS = Object.freeze({
  observers:4, nativeHandles:128, entries:1_000, visited:10_000, depth:32,
  patterns:16, patternLength:256, fileBytes:16_777_216, scanBytes:67_108_864,
  snapshotBytes:131_072, changes:256, queue:4, minIntervalMs:250,
  maxIntervalMs:60_000, defaultIntervalMs:1_000, minDebounceMs:10,
  maxDebounceMs:1_000, defaultDebounceMs:50, maxScanMs:30_000,
});
export const PROJECT_SCAN_REASONS = Object.freeze(['entry_limit','visit_limit','depth_limit','file_bytes','scan_bytes','snapshot_bytes','scan_timeout','unsafe_entries','unstable']);
export const PROJECT_RESYNC_REASONS = Object.freeze(['initial_changed','scan_changed','scan_incomplete','scan_recovered','native_unavailable','native_unknown','native_overflow','watcher_limit','consumer_overflow','change_limit','cursor_gap','revision_mismatch']);
const invalid = () => {throw workspaceFailure('invalid_request','Invalid project observation contract');};
function projectInteger(value, maximum, minimum=0) {if(!Number.isSafeInteger(value)||value<minimum||value>maximum)invalid();return value;}
const nullableSha = value => value===null ? null : requireSha256(value);
const list = (value,max) => {if(!Array.isArray(value)||value.length>max)invalid();return value;};
import {projectContains} from './project-patterns.mjs';

export function parseProjectWatchCapabilities(input){
  const value=copyWorkspaceJson(input);
  exactObject(value,['version','supported','platform','fileSystem','filesystemType','mode','rename','roots','limits']);
  if(value.version!==1||value.supported!==true||!['win32','linux'].includes(value.platform)||value.fileSystem!=='local'||typeof value.filesystemType!=='string'||!/^\d{1,20}$/.test(value.filesystemType)||value.mode!=='native-hints-with-reconciliation'||value.rename!=='delete-create')invalid();
  list(value.roots,16);if(!value.roots.length||new Set(value.roots).size!==value.roots.length)invalid();for(const root of value.roots)requireWorkspacePath(root,true);
  exactObject(value.limits,Object.keys(PROJECT_WATCH_LIMITS));for(const [key,limit] of Object.entries(PROJECT_WATCH_LIMITS))if(value.limits[key]!==limit)invalid();
  return Object.freeze({...value,roots:Object.freeze([...value.roots]),limits:PROJECT_WATCH_LIMITS});
}

/** Deliberately small glob language: *, ?, and whole-segment **; no regex. */
export function parseProjectPatterns(input) {
  const value=copyWorkspaceJson(input);
  list(value,PROJECT_WATCH_LIMITS.patterns);
  if(new Set(value).size!==value.length)invalid();
  for(const pattern of value){
    if(typeof pattern!=='string'||!pattern||pattern.length>PROJECT_WATCH_LIMITS.patternLength||!pattern.isWellFormed()||/[\\\u0000-\u001f\u007f:"<>|\[\]{}!]/u.test(pattern))invalid();
    if(pattern.split('/').some(p=>!p||p==='.'||p==='..'||p.includes('**')&&p!=='**'))invalid();
  }
  return Object.freeze([...value]);
}
export function parseProjectWatchOptions(input){
  const value=copyWorkspaceJson(input);
  exactObject(value,['root'],['include','exclude','maxDepth','maxEntries','maxFileBytes','maxScanBytes','scanTimeoutMs','intervalMs','debounceMs']);
  requireWorkspacePath(value.root,true);
  return Object.freeze({root:value.root,
    include:parseProjectPatterns(value.include??['**']),exclude:parseProjectPatterns(value.exclude??[]),
    maxDepth:projectInteger(value.maxDepth??8,PROJECT_WATCH_LIMITS.depth,1),
    maxEntries:projectInteger(value.maxEntries??512,PROJECT_WATCH_LIMITS.entries,1),
    maxFileBytes:projectInteger(value.maxFileBytes??1_048_576,PROJECT_WATCH_LIMITS.fileBytes,1),
    maxScanBytes:projectInteger(value.maxScanBytes??16_777_216,PROJECT_WATCH_LIMITS.scanBytes,1),
    scanTimeoutMs:projectInteger(value.scanTimeoutMs??10_000,PROJECT_WATCH_LIMITS.maxScanMs,1),
    intervalMs:projectInteger(value.intervalMs??PROJECT_WATCH_LIMITS.defaultIntervalMs,PROJECT_WATCH_LIMITS.maxIntervalMs,PROJECT_WATCH_LIMITS.minIntervalMs),
    debounceMs:projectInteger(value.debounceMs??PROJECT_WATCH_LIMITS.defaultDebounceMs,PROJECT_WATCH_LIMITS.maxDebounceMs,PROJECT_WATCH_LIMITS.minDebounceMs),
  });
}
export function parseProjectEntry(value){
  exactObject(value,['path','kind','size','revision','fingerprint']);requireWorkspacePath(value.path);projectInteger(value.size,Number.MAX_SAFE_INTEGER);nullableSha(value.revision);requireSha256(value.fingerprint);
  if(!['file','directory'].includes(value.kind)||value.kind==='directory'&&(value.size!==0||value.revision!==null)||value.kind==='file'&&value.revision!==null&&value.fingerprint!==value.revision)invalid();
  return Object.freeze({path:value.path,kind:value.kind,size:value.size,revision:value.revision,fingerprint:value.fingerprint});
}
export function parseProjectSnapshot(input){
  const value=copyWorkspaceJson(input,{maxBytes:PROJECT_WATCH_LIMITS.snapshotBytes,maxNodes:20_000});
  exactObject(value,['version','root','revision','entries','complete','reasons','observedAt']);
  if(value.version!==1||typeof value.complete!=='boolean')invalid();requireWorkspacePath(value.root,true);requireSha256(value.revision);projectInteger(value.observedAt,Number.MAX_SAFE_INTEGER);
  const entries=list(value.entries,PROJECT_WATCH_LIMITS.entries).map(parseProjectEntry);
  if(entries.some((entry,i)=>!projectContains(value.root,entry.path)||entry.path===value.root||i>0&&entries[i-1].path>=entry.path))invalid();
  if(value.complete&&entries.some(entry=>entry.kind==='file'&&entry.revision===null))invalid();
  const reasons=list(value.reasons,PROJECT_SCAN_REASONS.length);
  if(reasons.some(reason=>!PROJECT_SCAN_REASONS.includes(reason))||new Set(reasons).size!==reasons.length||value.complete!==(reasons.length===0))invalid();
  return Object.freeze({...value,entries:Object.freeze(entries)});
}
export function parseProjectWatchEvent(input){
  const value=copyWorkspaceJson(input,{maxBytes:786_432,maxNodes:40_000});
  exactObject(value,['version','subscriptionId','cursor','kind','previousRevision','snapshot','changes','reason']);
  if(value.version!==1||!['snapshot','changes','resync'].includes(value.kind))invalid();requireUuid(value.subscriptionId);projectInteger(value.cursor,Number.MAX_SAFE_INTEGER,1);nullableSha(value.previousRevision);
  const snapshot=parseProjectSnapshot(value.snapshot);
  const changes=list(value.changes,PROJECT_WATCH_LIMITS.changes).map(change=>{
    exactObject(change,['kind','path','previous','current']);requireWorkspacePath(change.path);
    if(!projectContains(snapshot.root,change.path))invalid();
    const previous=change.previous===null?null:parseProjectEntry(change.previous),current=change.current===null?null:parseProjectEntry(change.current);
    if(previous&&previous.path!==change.path||current&&current.path!==change.path)invalid();
    if(change.kind==='created'?previous!==null||current===null:change.kind==='deleted'?previous===null||current!==null:change.kind==='changed'?previous===null||current===null: true)invalid();
    return Object.freeze({...change,previous,current});
  });
  if(new Set(changes.map(x=>x.path)).size!==changes.length)invalid();
  const currentEntries=new Map(snapshot.entries.map(entry=>[entry.path,entry]));
  for(const change of changes){if(change.current?JSON.stringify(change.current)!==JSON.stringify(currentEntries.get(change.path)):currentEntries.has(change.path))invalid();if(change.kind==='changed'&&JSON.stringify(change.previous)===JSON.stringify(change.current))invalid();}
  if((value.cursor===1)!==(value.previousRevision===null)||value.kind!=='resync'&&!snapshot.complete||value.kind==='snapshot'&&value.cursor!==1||value.kind==='changes'&&value.previousRevision===snapshot.revision)invalid();
  if(value.kind==='snapshot'&&(value.previousRevision!==null||changes.length||value.reason!==null)||value.kind==='changes'&&(value.previousRevision===null||!changes.length||value.reason!==null)||value.kind==='resync'&&(!PROJECT_RESYNC_REASONS.includes(value.reason)||changes.length))invalid();
  return Object.freeze({...value,snapshot,changes:Object.freeze(changes)});
}
