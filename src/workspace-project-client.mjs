import {copyWorkspaceJson,exactObject,workspaceFailure,WorkspaceError,WORKSPACE_LIMITS} from './workspace-values.mjs';
import {parseProjectWatchOptions,parseProjectWatchEvent} from './project-watch.mjs';
import {parseProjectQueryOptions,parseProjectQueryCursor} from './project-query.mjs';
import {projectContains,projectMatches} from './project-patterns.mjs';
import {WORKSPACE_PROJECT_LIMITS,parseWorkspaceProjectCapabilities} from './workspace-project-contracts.mjs';

const invalid=message=>workspaceFailure('invalid_request',message);
const fold=value=>value.replace(/[A-Z]/g,char=>char.toLowerCase());
const digest=async value=>[...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const sameEntries=(left,right)=>JSON.stringify(left)===JSON.stringify(right);

/** Browser-safe facade; transport, binding and detached cleanup remain private. */
export function createWorkspaceProjectClient({request,getBinding,getSignal,checkConnection,detachedRequest,defaultTimeoutMs}){
  let capabilityBinding,capability;
  const active=new Set();
  function check(binding,options){checkConnection(binding,options);}
  function within(cap,root){if(!cap.enabled)throw workspaceFailure('unsupported','Project tools are unavailable on this host');if(!cap.watch.roots.some(allowed=>projectContains(allowed,root)))throw workspaceFailure('permission_denied','Project root is outside the operator scope');}
  async function getProjectCapabilities(options){
    const binding=getBinding();check(binding,options);
    if(binding===capabilityBinding)return capability;
    let result;
    const legacy=()=>parseWorkspaceProjectCapabilities({protocolVersion:1,enabled:false,scope:{projectId:binding.workspace.id,sessionId:binding.workspace.generation},watch:null,query:null,limits:WORKSPACE_PROJECT_LIMITS});
    // Released older SDK servers cannot correlate replies for unknown methods.
    if(binding.hostId==='workspace-host'&&/^0\.[0-8]\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(binding.hostVersion))result=legacy();
    else try{result=await request('projects.capabilities',{},options);}catch(error){if(!(error instanceof WorkspaceError)||error.code!=='unsupported')throw error;result=legacy();}
    check(binding,options);capabilityBinding=binding;capability=result;return result;
  }
  function validatePaths(entries,options){
    if(entries.length>options.maxEntries)throw invalid('Project entry count exceeds the selected limit');
    for(const entry of entries){
      if(!projectContains(options.root,entry.path)||entry.path===options.root)throw invalid('Project reply root mismatch');
      const relative=options.root?entry.path.slice(options.root.length+1):entry.path;
      if(relative.split('/').length>options.maxDepth||!projectMatches(options.include,relative)||projectMatches(options.exclude,relative)||relative.split('/').some((_,i,parts)=>projectMatches(options.exclude,parts.slice(0,i+1).join('/'))))throw invalid('Project reply filter mismatch');
    }
  }
  async function validateSnapshot(snapshot,options,binding,requestOptions){
    if(snapshot.root!==options.root)throw invalid('Project snapshot root mismatch');validatePaths(snapshot.entries,options);
    const sha=await digest(JSON.stringify({root:snapshot.root,entries:snapshot.entries,reasons:snapshot.reasons}));check(binding,requestOptions);
    if(sha!==snapshot.revision)throw invalid('Project snapshot digest mismatch');
  }
  async function getProjectSnapshot(input,options){
    const parsed=parseProjectWatchOptions(input),binding=getBinding(),cap=await getProjectCapabilities(options);check(binding,options);within(cap,parsed.root);
    const result=await request('projects.snapshot',{options:parsed},options);await validateSnapshot(result.snapshot,parsed,binding,options);return result.snapshot;
  }
  async function query(kind,input,options){
    const supplied=copyWorkspaceJson(input);if(Object.hasOwn(supplied,'kind'))throw invalid('Query method selects its kind');
    const parsed=parseProjectQueryOptions({...supplied,kind}),binding=getBinding(),cap=await getProjectCapabilities(options);check(binding,options);within(cap,parsed.root);
    const result=await request('projects.query',{query:parsed},options),page=result.page;
    const {cursor,...normalized}=parsed,queryHash=await digest(JSON.stringify(normalized));check(binding,options);
    if(page.root!==parsed.root||page.kind!==kind||page.queryHash!==queryHash||page.items.length>parsed.pageSize||page.total>parsed.maxResults||new TextEncoder().encode(JSON.stringify(page)).byteLength>parsed.maxResponseBytes)throw invalid('Project query reply mismatch');
    if(cursor){const [id,offset]=cursor.split(':');if(page.viewId!==id||page.offset!==Number(offset))throw invalid('Project query cursor mismatch');}else if(page.offset!==0)throw invalid('Initial project query offset mismatch');
    validatePaths([...new Map(page.items.map(item=>[item.entry.path,item.entry])).values()],parsed);
    const needle=parsed.caseSensitive?parsed.query:parsed.query===undefined?undefined:fold(parsed.query);
    for(const item of page.items){
      if(kind==='files'){const relative=parsed.root?item.entry.path.slice(parsed.root.length+1):item.entry.path,name=parsed.caseSensitive?relative:fold(relative);if(parsed.mode==='glob'?!projectMatches([needle],name):!name.includes(needle))throw invalid('Filename search reply mismatch');}
      if(kind==='text'){const {range,snippet}=item.match;let actual=snippet.text.slice(range.start.character-snippet.startCharacter,range.end.character-snippet.startCharacter);if(!parsed.caseSensitive)actual=fold(actual);if(actual!==needle||item.entry.size>parsed.maxFileBytes)throw invalid('Text search reply mismatch');}
    }
    return page;
  }
  async function releaseProjectQuery(cursor,options){parseProjectQueryCursor(cursor);const binding=getBinding(),cap=await getProjectCapabilities(options);check(binding,options);if(!cap.enabled)throw workspaceFailure('unsupported','Project tools are unavailable on this host');return(await request('projects.query.release',{cursor},options)).released;}

  function watchProject(input,value={}){
    const parsed=parseProjectWatchOptions(input);
    exactObject(value,[],['signal','requestTimeoutMs','timeoutMs']);
    if(value.signal!==undefined&&!(value.signal instanceof AbortSignal))throw invalid('Expected AbortSignal');
    for(const [name,max] of [['requestTimeoutMs',WORKSPACE_LIMITS.maxTimeoutMs],['timeoutMs',WORKSPACE_PROJECT_LIMITS.maxWatchMs]])if(value[name]!==undefined&&(!Number.isSafeInteger(value[name])||value[name]<1||value[name]>max))throw invalid('Invalid project observation timeout');
    const binding=getBinding();check(binding,{signal:value.signal});
    const controller=new AbortController(),subscriptionId=globalThis.crypto.randomUUID(),listeners=[];
    const requestOptions={signal:controller.signal,timeoutMs:value.requestTimeoutMs??defaultTimeoutMs};
    let started=false,ended=false,busy=false,graceful=false,delivered=false,failure,cleanup=Promise.resolve(),deadline,remoteStarted=false,previous;
    function stop(reason){
      if(ended)return cleanup;ended=true;failure=reason;clearTimeout(deadline);
      for(const [signal,callback] of listeners)signal.removeEventListener('abort',callback);listeners.length=0;active.delete(controller);
      controller.abort(reason??workspaceFailure('disposed','Project observation ended'));
      if(remoteStarted)cleanup=detachedRequest('projects.watch.stop',{subscriptionId},binding);
      return cleanup;
    }
    function current(){if(ended)throw failure??workspaceFailure('disposed','Project observation ended');check(binding,requestOptions);}
    function listen(signal,reason){const callback=()=>stop(reason());signal.addEventListener('abort',callback,{once:true});listeners.push([signal,callback]);if(signal.aborted)callback();}
    async function begin(){
      current();if(active.size>=WORKSPACE_PROJECT_LIMITS.subscriptions)throw workspaceFailure('budget_exceeded','Client project observer limit exceeded');
      active.add(controller);started=true;
      const connection=getSignal();listen(connection,()=>connection.reason instanceof WorkspaceError?connection.reason:workspaceFailure('disposed','Workspace connection changed'));
      if(value.signal)listen(value.signal,()=>workspaceFailure('cancelled','Project observation cancelled'));
      if(value.timeoutMs!==undefined)deadline=setTimeout(()=>stop(workspaceFailure('budget_exceeded','Project observation timed out')),value.timeoutMs);
      const cap=await getProjectCapabilities(requestOptions);current();within(cap,parsed.root);remoteStarted=true;
      return request('projects.watch.start',{subscriptionId,options:parsed},requestOptions);
    }
    async function event(result){
      current();if(result.subscriptionId!==subscriptionId||result.after!==(previous?.cursor??0))throw invalid('Project poll identity or cursor mismatch');
      if(result.event===null)return null;
      let update=result.event;
      if(previous&&update.subscriptionId!==previous.subscriptionId)throw invalid('Project native subscription identity changed');
      await validateSnapshot(update.snapshot,parsed,binding,requestOptions);current();
      if(previous&&update.kind!=='resync'){
        let reason;
        if(update.cursor!==previous.cursor+1)reason='cursor_gap';
        else if(update.previousRevision!==previous.snapshot.revision)reason='revision_mismatch';
        else{
          const entries=new Map(previous.snapshot.entries.map(entry=>[entry.path,entry]));
          for(const change of update.changes){if(!sameEntries(entries.get(change.path)??null,change.previous))reason='revision_mismatch';if(change.current)entries.set(change.path,change.current);else entries.delete(change.path);}
          const patched=[...entries.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
          if(!sameEntries(patched,update.snapshot.entries))reason='revision_mismatch';
        }
        if(reason)update=parseProjectWatchEvent({...update,kind:'resync',changes:[],reason});
      }
      previous=update;return update;
    }
    const iterator={
      async next(){
        if(busy)throw workspaceFailure('conflict','Project observation already has a pending read');
        if(ended){if(failure&&!delivered){delivered=true;throw failure;}return{done:true,value:undefined};}
        busy=true;
        try{
          for(;;){const result=!started?await begin():await request('projects.watch.next',{subscriptionId,after:previous.cursor,waitMs:Math.max(1,Math.min(WORKSPACE_PROJECT_LIMITS.maxPollMs,requestOptions.timeoutMs-100))},requestOptions);const update=await event(result);current();if(update)return{done:false,value:update};}
        }catch(error){if(graceful)return{done:true,value:undefined};stop(error);delivered=true;throw failure??error;}
        finally{busy=false;}
      },
      async return(){graceful=true;delivered=true;await stop();return{done:true,value:undefined};},
      [Symbol.asyncIterator](){return iterator;},
    };
    return Object.freeze(iterator);
  }
  return Object.freeze({getProjectCapabilities,getProjectSnapshot,listTree:(input,options)=>query('tree',input,options),searchFiles:(input,options)=>query('files',input,options),searchText:(input,options)=>query('text',input,options),releaseProjectQuery,watchProject});
}
