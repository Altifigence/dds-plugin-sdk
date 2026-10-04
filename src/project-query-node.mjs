import {createHash,randomUUID} from 'node:crypto';
import {nodeProjectContext} from './node-project-context.mjs';
import {copyWorkspaceJson,exactObject,workspaceFailure} from './workspace-protocol.mjs';
import {PROJECT_QUERY_LIMITS as limits,parseProjectQueryOptions,parseProjectQueryPage,parseProjectQueryCursor,parseProjectQueryCapabilities} from './project-query.mjs';
import {projectMatches} from './project-patterns.mjs';
import {projectAbort} from './project-scan-node.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
// ASCII-only folding preserves every UTF-16 offset, including non-BMP characters.
const fold=value=>value.replace(/[A-Z]/g,char=>char.toLowerCase());
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const compare=(a,b)=>a.entry.path<b.entry.path?-1:a.entry.path>b.entry.path?1:(a.match?.range.start.line??0)-(b.match?.range.start.line??0)||(a.match?.range.start.character??0)-(b.match?.range.start.character??0);
function snippet(line,start,end){
  let left=Math.max(0,start-80),right=Math.min(line.length,left+limits.snippetChars);
  if(left>0&&/[\uDC00-\uDFFF]/u.test(line[left]))left--;
  right=Math.min(right,left+limits.snippetChars);
  if(right<line.length&&/[\uDC00-\uDFFF]/u.test(line[right]))right--;
  return{text:line.slice(left,right),startCharacter:left,leading:left>0,trailing:right<line.length};
}

/** Read-only queries share the watcher's explicit scope, scanner and lifetime. */
export function createNodeProjectQueries({watcher,cursorTtlMs=limits.cursorTtlMs}={}){
  const context=nodeProjectContext(watcher);
  if(!context)throw workspaceFailure('invalid_request','A concrete Node project watcher is required');
  if(!Number.isSafeInteger(cursorTtlMs)||cursorTtlMs<1||cursorTtlMs>limits.cursorTtlMs)throw workspaceFailure('invalid_request','Invalid query cursor lifetime');
  const views=new Map(),controller=new AbortController();let closed=false,failure,active=0;
  function check(signal){if(closed)throw failure??workspaceFailure('disposed','Project queries are disposed');context.check(signal);projectAbort(controller.signal);}
  function clearExpired(){const now=Date.now();for(const [id,view] of views)if(view.expiresAt<=now)views.delete(id);}
  function dispose(reason=workspaceFailure('disposed','Project queries are disposed')){if(closed)return;closed=true;failure=reason;controller.abort(reason);views.clear();context.signal.removeEventListener('abort',parentAbort);}
  const parentAbort=()=>dispose(context.signal.reason);context.signal.addEventListener('abort',parentAbort,{once:true});
  if(context.signal.aborted)parentAbort();
  async function run(kind,input,request={}){
    const supplied=copyWorkspaceJson(input);if(Object.hasOwn(supplied,'kind'))throw workspaceFailure('invalid_request','Query method selects its kind');
    const options=parseProjectQueryOptions({...supplied,kind});
    exactObject(request,[],['signal']);if(request.signal!==undefined&&!(request.signal instanceof AbortSignal))throw workspaceFailure('invalid_request','Expected AbortSignal');
    const signal=AbortSignal.any([controller.signal,context.signal,...(request.signal?[request.signal]:[])]);
    check(signal);clearExpired();
    const {cursor,...query}=options,{kind:_,query:term,mode,caseSensitive,pageSize,maxResults,maxResponseBytes,...scanInput}=query;
    const scanOptions=context.options(scanInput),queryHash=sha(JSON.stringify(query)),deadline=Date.now()+scanOptions.scanTimeoutMs;
    let view,index=0;
    if(cursor){const [id,offset]=cursor.split(':');view=views.get(id);index=Number(offset);if(!view)throw workspaceFailure('not_found','Project query cursor expired or was released');if(view.queryHash!==queryHash||!view.issued.has(index))throw workspaceFailure('invalid_request','Project query cursor does not match this query');}
    else if(views.size>=limits.views)throw workspaceFailure('budget_exceeded','Project query view limit exceeded; release an unused cursor');
    if(active>=limits.concurrent)throw workspaceFailure('budget_exceeded','Project query concurrency limit exceeded');
    active++;
    try{
      let current;
      if(!view){
        const items=[],reasons=new Set();let retainedBytes=0;
        const add=(entry,match=null)=>{
          if(items.length>=maxResults){reasons.add('result_limit');return false;}
          const item={entry,match},size=bytes(item);
          if(retainedBytes+size>limits.viewBytes){reasons.add('result_bytes');return false;}
          items.push(item);retainedBytes+=size;return true;
        };
        const needle=caseSensitive?term:term===undefined?undefined:fold(term);
        const snapshot=await context.scan(scanOptions,{signal,deadline,...(kind==='text'?{onFile(entry,content){
          check(signal);
          if(content.includes(0)){reasons.add('binary');return;}
          let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}catch{reasons.add('invalid_utf8');return;}
          const lines=text.split(/\r\n|\r|\n/u);
          for(let lineIndex=0;lineIndex<lines.length;lineIndex++){
            const line=lines[lineIndex],search=caseSensitive?line:fold(line);
            let from=0,at;
            while((at=search.indexOf(needle,from))!==-1){
              const end=at+needle.length;
              if(!add(entry,{range:{start:{line:lineIndex,character:at},end:{line:lineIndex,character:end}},snippet:snippet(line,at,end)}))return;
              from=end;
            }
          }
        }}:{})});
        for(const reason of snapshot.reasons)reasons.add(reason);
        if(kind!=='text')for(const entry of snapshot.entries){
          if(kind==='files'){
            if(entry.kind!=='file')continue;
            const relative=query.root?entry.path.slice(query.root.length+1):entry.path,name=caseSensitive?relative:fold(relative);
            if(mode==='glob'?!projectMatches([needle],name):!name.includes(needle))continue;
          }
          if(!add(entry))break;
        }
        items.sort(compare);check(signal);
        view={id:randomUUID(),queryHash,query,snapshot,items,reasons:[...reasons].sort(),expiresAt:Date.now()+cursorTtlMs,issued:new Set(),retainedBytes};
        current=snapshot;
      }else current=await context.scan(scanOptions,{signal,deadline});
      check(signal);
      if(cursor&&(Date.now()>=view.expiresAt||views.get(view.id)!==view))throw workspaceFailure('not_found','Project query cursor expired or was released');
      const now=new Map(current.entries.map(entry=>[entry.path,entry]));
      const stale=current.revision!==view.snapshot.revision||current.reasons.includes('unstable'),items=[];let pageBytes=4_096;
      for(const item of view.items.slice(index,index+pageSize)){
        const latest=now.get(item.entry.path);let state,currentRevision=null;
        if(!latest)state=current.complete?'missing':'unverified';
        else if(latest.kind!==item.entry.kind)state='changed';
        else if(latest.kind==='directory')state=latest.fingerprint===item.entry.fingerprint?'current':'changed';
        else if(latest.revision===null||item.entry.revision===null)state='unverified';
        else{currentRevision=latest.revision;state=latest.revision===item.entry.revision?'current':'changed';}
        const result={...item,state,currentRevision},size=bytes(result)+1;
        if(pageBytes+size>maxResponseBytes)break;
        items.push(result);pageBytes+=size;
      }
      if(index<view.items.length&&!items.length)throw workspaceFailure('budget_exceeded','Project query item exceeds the response budget');
      const nextIndex=index+items.length,nextCursor=nextIndex<view.items.length?view.id+':'+nextIndex:null;
      const page=parseProjectQueryPage({version:1,viewId:view.id,kind,root:query.root,queryHash,snapshotRevision:view.snapshot.revision,observedAt:view.snapshot.observedAt,checkedAt:Math.max(Date.now(),view.snapshot.observedAt),expiresAt:view.expiresAt,offset:index,total:view.items.length,items,nextCursor,complete:view.reasons.length===0,truncated:view.reasons.length>0,reasons:view.reasons,stale});
      check(signal);
      if(nextCursor){clearExpired();if(!cursor&&views.size>=limits.views)throw workspaceFailure('budget_exceeded','Project query view limit exceeded');view.issued.add(nextIndex);views.set(view.id,view);}
      return page;
    }finally{active--;}
  }
  return Object.freeze({
    capabilities:parseProjectQueryCapabilities({version:1,supported:true,kinds:['tree','files','text'],caseFolding:'ascii',ranges:'utf16-zero-based',cursor:'query-bound-frozen-membership',roots:watcher.capabilities.roots,limits}),
    listTree:(input,request)=>run('tree',input,request),
    searchFiles:(input,request)=>run('files',input,request),
    searchText:(input,request)=>run('text',input,request),
    releaseCursor(cursor){check();parseProjectQueryCursor(cursor);return views.delete(cursor.split(':')[0]);},
    inspect(){clearExpired();return Object.freeze({activeQueries:active,views:views.size,retainedBytes:[...views.values()].reduce((sum,view)=>sum+view.retainedBytes,0),closed});},
    revoke(){dispose(workspaceFailure('permission_denied','Project query permission was revoked'));},
    dispose(){dispose();},
  });
}
