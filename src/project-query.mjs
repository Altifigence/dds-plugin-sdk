import {copyWorkspaceJson,exactObject,requireSha256,requireUuid,requireWorkspacePath,workspaceFailure} from './workspace-protocol.mjs';
import {parseProjectWatchOptions,parseProjectPatterns,parseProjectEntry,PROJECT_SCAN_REASONS} from './project-watch.mjs';
import {projectContains} from './project-patterns.mjs';

export const PROJECT_QUERY_LIMITS=Object.freeze({concurrent:2,views:8,cursorTtlMs:60_000,pageSize:64,results:512,queryChars:256,snippetChars:512,textFileBytes:262_144,responseBytes:131_072,minResponseBytes:16_384,viewBytes:262_144});
export const PROJECT_QUERY_REASONS=Object.freeze([...PROJECT_SCAN_REASONS,'result_limit','result_bytes','binary','invalid_utf8']);
const invalid=()=>{throw workspaceFailure('invalid_request','Invalid project query contract');};
const integer=(n,max,min=0)=>{if(!Number.isSafeInteger(n)||n<min||n>max)invalid();return n;};
const bool=value=>{if(typeof value!=='boolean')invalid();return value;};
const kinds=['tree','files','text'],states=['current','changed','missing','unverified'];
const cursorPattern=/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([1-9][0-9]{0,2})$/;
export function parseProjectQueryCursor(value){if(typeof value!=='string'||!cursorPattern.test(value)||Number(value.split(':')[1])>=PROJECT_QUERY_LIMITS.results)invalid();return value;}

export function parseProjectQueryCapabilities(input){
  const value=copyWorkspaceJson(input);
  exactObject(value,['version','supported','kinds','caseFolding','ranges','cursor','roots','limits']);
  if(value.version!==1||value.supported!==true||JSON.stringify(value.kinds)!==JSON.stringify(kinds)||value.caseFolding!=='ascii'||value.ranges!=='utf16-zero-based'||value.cursor!=='query-bound-frozen-membership')invalid();
  if(!Array.isArray(value.roots)||value.roots.length<1||value.roots.length>16||new Set(value.roots).size!==value.roots.length)invalid();
  for(const root of value.roots)requireWorkspacePath(root,true);
  exactObject(value.limits,Object.keys(PROJECT_QUERY_LIMITS));for(const [key,limit] of Object.entries(PROJECT_QUERY_LIMITS))if(value.limits[key]!==limit)invalid();
  return Object.freeze({...value,kinds:Object.freeze([...kinds]),roots:Object.freeze([...value.roots]),limits:PROJECT_QUERY_LIMITS});
}

export function parseProjectQueryOptions(input){
  const value=copyWorkspaceJson(input);
  exactObject(value,['kind','root'],['include','exclude','maxDepth','maxEntries','maxFileBytes','maxScanBytes','scanTimeoutMs','pageSize','maxResults','maxResponseBytes','query','mode','caseSensitive','cursor']);
  if(!kinds.includes(value.kind))invalid();
  const scan={root:value.root};for(const name of ['include','exclude','maxDepth','maxEntries','maxFileBytes','maxScanBytes','scanTimeoutMs'])if(value[name]!==undefined)scan[name]=value[name];
  if(value.kind==='text')scan.maxFileBytes??=PROJECT_QUERY_LIMITS.textFileBytes;
  const {intervalMs:_,debounceMs:__,...normalized}=parseProjectWatchOptions(scan);
  if(value.kind==='text'&&normalized.maxFileBytes>PROJECT_QUERY_LIMITS.textFileBytes)invalid();
  if(value.kind==='tree'&&(value.query!==undefined||value.mode!==undefined||value.caseSensitive!==undefined))invalid();
  let query=null,mode=null,caseSensitive=true;
  if(value.kind!=='tree'){
    query=value.query;
    if(typeof query!=='string'||!query||query.length>PROJECT_QUERY_LIMITS.queryChars||!query.isWellFormed()||/[\u0000-\u001f\u007f]/u.test(query))invalid();
    mode=value.mode??'literal';if(!['literal','glob'].includes(mode)||value.kind==='text'&&mode!=='literal')invalid();
    if(mode==='glob')parseProjectPatterns([query]);
    caseSensitive=bool(value.caseSensitive??true);
  }
  return Object.freeze({...normalized,kind:value.kind,...(query===null?{}:{query,mode,caseSensitive}),pageSize:integer(value.pageSize??32,PROJECT_QUERY_LIMITS.pageSize,1),maxResults:integer(value.maxResults??256,PROJECT_QUERY_LIMITS.results,1),maxResponseBytes:integer(value.maxResponseBytes??65_536,PROJECT_QUERY_LIMITS.responseBytes,PROJECT_QUERY_LIMITS.minResponseBytes),...(value.cursor===undefined?{}:{cursor:parseProjectQueryCursor(value.cursor)})});
}

function parseMatch(value){
  exactObject(value,['range','snippet']);exactObject(value.range,['start','end']);
  for(const point of [value.range.start,value.range.end]){exactObject(point,['line','character']);integer(point.line,PROJECT_QUERY_LIMITS.textFileBytes);integer(point.character,PROJECT_QUERY_LIMITS.textFileBytes);}
  const {start,end}=value.range;if(start.line!==end.line||start.character>=end.character||end.character-start.character>PROJECT_QUERY_LIMITS.queryChars)invalid();
  const snippet=value.snippet;exactObject(snippet,['text','startCharacter','leading','trailing']);
  if(typeof snippet.text!=='string'||!snippet.text.isWellFormed()||snippet.text.length>PROJECT_QUERY_LIMITS.snippetChars||/[\r\n\u0000]/u.test(snippet.text))invalid();
  integer(snippet.startCharacter,PROJECT_QUERY_LIMITS.textFileBytes);bool(snippet.leading);bool(snippet.trailing);
  if(snippet.startCharacter>start.character||snippet.startCharacter+snippet.text.length<end.character||snippet.leading!==(snippet.startCharacter>0))invalid();
  return Object.freeze({range:Object.freeze({start:Object.freeze({...start}),end:Object.freeze({...end})}),snippet:Object.freeze({...snippet})});
}
export function parseProjectQueryPage(input){
  const value=copyWorkspaceJson(input,{maxBytes:PROJECT_QUERY_LIMITS.responseBytes,maxNodes:20_000});
  exactObject(value,['version','viewId','kind','root','queryHash','snapshotRevision','observedAt','checkedAt','expiresAt','offset','total','items','nextCursor','complete','truncated','reasons','stale']);
  if(value.version!==1||!kinds.includes(value.kind))invalid();requireUuid(value.viewId);requireWorkspacePath(value.root,true);requireSha256(value.queryHash);requireSha256(value.snapshotRevision);
  for(const key of ['observedAt','checkedAt','expiresAt'])integer(value[key],Number.MAX_SAFE_INTEGER);
  if(value.expiresAt<value.observedAt||value.checkedAt<value.observedAt)invalid();
  integer(value.offset,PROJECT_QUERY_LIMITS.results);integer(value.total,PROJECT_QUERY_LIMITS.results);bool(value.complete);bool(value.truncated);bool(value.stale);
  if(!Array.isArray(value.reasons)||new Set(value.reasons).size!==value.reasons.length||value.reasons.some(x=>!PROJECT_QUERY_REASONS.includes(x))||value.complete!==(value.reasons.length===0)||value.truncated===value.complete)invalid();
  if(!Array.isArray(value.items)||value.items.length>PROJECT_QUERY_LIMITS.pageSize||value.offset+value.items.length>value.total)invalid();
  const items=value.items.map(item=>{
    exactObject(item,['entry','match','state','currentRevision']);const entry=parseProjectEntry(item.entry);
    if(!projectContains(value.root,entry.path)||entry.path===value.root||!states.includes(item.state))invalid();
    if(item.currentRevision!==null)requireSha256(item.currentRevision);
    const match=item.match===null?null:parseMatch(item.match);
    if(value.kind==='text'?(match===null||entry.kind!=='file'||entry.revision===null):match!==null)invalid();
    if(match&&match.range.start.line+match.range.end.character>entry.size)invalid();
    if(value.kind==='files'&&entry.kind!=='file')invalid();
    if(item.state==='current'&&entry.kind==='file'&&(entry.revision===null||item.currentRevision!==entry.revision))invalid();
    if(item.state==='changed'&&entry.kind==='file'&&item.currentRevision!==null&&item.currentRevision===entry.revision)invalid();
    if(item.state==='missing'&&item.currentRevision!==null||item.state==='unverified'&&item.currentRevision!==null||entry.kind==='directory'&&item.currentRevision!==null)invalid();
    return Object.freeze({entry,match,state:item.state,currentRevision:item.currentRevision});
  });
  for(let i=1;i<items.length;i++){const a=items[i-1],b=items[i];if(a.entry.path>b.entry.path||a.entry.path===b.entry.path&&(value.kind!=='text'||a.match.range.start.line>b.match.range.start.line||a.match.range.start.line===b.match.range.start.line&&a.match.range.start.character>=b.match.range.start.character))invalid();}
  if(value.nextCursor!==null){parseProjectQueryCursor(value.nextCursor);if(value.nextCursor!==value.viewId+':'+(value.offset+items.length)||!items.length||value.offset+items.length>=value.total)invalid();}
  else if(value.offset+items.length!==value.total)invalid();
  if(!value.stale&&items.some(x=>['changed','missing'].includes(x.state)))invalid();
  return Object.freeze({...value,items:Object.freeze(items),reasons:Object.freeze([...value.reasons])});
}
