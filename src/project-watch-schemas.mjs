import {PROJECT_WATCH_LIMITS as limits,PROJECT_SCAN_REASONS,PROJECT_RESYNC_REASONS} from './project-watch.mjs';
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const integer=(maximum,minimum=0)=>({type:'integer',minimum,maximum});
const text=maximum=>({type:'string',maxLength:maximum});
const list=(items,maximum)=>({type:'array',items,maxItems:maximum});
const sha={type:'string',pattern:'^[a-f0-9]{64}$'},nullableSha={oneOf:[sha,{type:'null'}]};
const path={...text(1024),minLength:1,$comment:'Runtime applies workspace-relative protected-path and Windows-component rules.'};
const root={...text(1024),$comment:'Empty root requires explicit operator scope.'};
const patterns={...list({...text(limits.patternLength),minLength:1},limits.patterns),uniqueItems:true,$comment:'Runtime supports *, ?, and whole-segment ** only.'};
const entry={...object({path,kind:{enum:['file','directory']},size:integer(Number.MAX_SAFE_INTEGER),revision:nullableSha,fingerprint:sha}),allOf:[{if:{properties:{kind:{const:'directory'}}},then:{properties:{size:{const:0},revision:{type:'null'}}}}],$comment:'For hashed files fingerprint equals the content revision. Otherwise it is opaque metadata, not a content checksum.'};
const snapshot={...object({version:{const:1},root,revision:sha,entries:list(entry,limits.entries),complete:{type:'boolean'},reasons:{...list({enum:PROJECT_SCAN_REASONS},PROJECT_SCAN_REASONS.length),uniqueItems:true},observedAt:integer(Number.MAX_SAFE_INTEGER)}),'x-maxUtf8Bytes':limits.snapshotBytes,$comment:'Runtime checks sorted unique scoped paths and complete iff reasons is empty. This is a bounded per-file validated view, not a filesystem transaction.'};
snapshot.allOf=[{if:{properties:{complete:{const:true}}},then:{properties:{reasons:{maxItems:0},entries:{items:{if:{properties:{kind:{const:'file'}}},then:{properties:{revision:sha}}}}}},else:{properties:{reasons:{minItems:1}}}}];
const change={oneOf:['created','changed','deleted'].map(kind=>object({kind:{const:kind},path,previous:kind==='created'?{type:'null'}:entry,current:kind==='deleted'?{type:'null'}:entry}))};
export const PROJECT_WATCH_SCHEMAS=Object.freeze({
  'project-watch-options':{...object({root,include:patterns,exclude:patterns,maxDepth:integer(limits.depth,1),maxEntries:integer(limits.entries,1),maxFileBytes:integer(limits.fileBytes,1),maxScanBytes:integer(limits.scanBytes,1),scanTimeoutMs:integer(limits.maxScanMs,1),intervalMs:integer(limits.maxIntervalMs,limits.minIntervalMs),debounceMs:integer(limits.maxDebounceMs,limits.minDebounceMs)},['root']),$comment:'Runtime applies defaults, rejects unknown fields, and intersects root with operator-configured roots.'},
  'project-entry':entry,
  'project-snapshot':snapshot,
  'project-watch-event':{...object({version:{const:1},subscriptionId:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'},cursor:integer(Number.MAX_SAFE_INTEGER,1),kind:{enum:['snapshot','changes','resync']},previousRevision:nullableSha,snapshot,changes:list(change,limits.changes),reason:{oneOf:[{enum:PROJECT_RESYNC_REASONS},{type:'null'}]}}),allOf:[{if:{properties:{kind:{const:'snapshot'}}},then:{properties:{previousRevision:{type:'null'},changes:{maxItems:0},reason:{type:'null'}}}},{if:{properties:{kind:{const:'changes'}}},then:{properties:{previousRevision:sha,changes:{minItems:1},reason:{type:'null'}}}},{if:{properties:{kind:{const:'resync'}}},then:{properties:{changes:{maxItems:0},reason:{enum:PROJECT_RESYNC_REASONS}}}}],$comment:'Runtime checks unique change paths and matching before/after entries. Cursor is local to one subscription. Rename is represented as delete/create.'},
});
PROJECT_WATCH_SCHEMAS['project-watch-event'].allOf.push(
  {if:{properties:{cursor:{const:1}}},then:{properties:{previousRevision:{type:'null'}}},else:{properties:{previousRevision:sha}}},
  {if:{properties:{kind:{enum:['snapshot','changes']}}},then:{properties:{snapshot:{properties:{complete:{const:true}}}}}},
  {if:{properties:{kind:{const:'snapshot'}}},then:{properties:{cursor:{const:1}}}},
);
