import {watch as nativeWatch} from 'node:fs';
import {statfs} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {nodeWorkspaceContext} from './node-workspace-context.mjs';
import {workspaceFailure,requireWorkspacePath,exactObject} from './workspace-protocol.mjs';
import {PROJECT_WATCH_LIMITS,parseProjectWatchOptions,parseProjectWatchEvent} from './project-watch.mjs';
import {projectContains} from './project-patterns.mjs';
import {scanNodeProject,projectAbort,projectFileError} from './project-scan-node.mjs';

const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
/** Optional local-filesystem port. The caller owns scope and explicit revocation. */
export async function createNodeProjectWatcher({workspace,roots,fileSystem}={}){
  const context=nodeWorkspaceContext(workspace);
  if(!context)throw workspaceFailure('invalid_request','A concrete Node workspace is required');
  if(fileSystem!=='local'||!['win32','linux'].includes(process.platform))throw workspaceFailure('unsupported','Project observation supports an explicitly selected local Windows or Linux filesystem');
  if(!Array.isArray(roots)||!roots.length||roots.length>16||new Set(roots).size!==roots.length)throw workspaceFailure('invalid_request','Explicit allowed project roots are required');
  roots=Object.freeze(roots.map(root=>requireWorkspacePath(root,true)));
  await context.checkRoot();
  for(const root of roots){const checked=await context.resolve(root,{allowRoot:true});if(!checked.stat.isDirectory())throw workspaceFailure('invalid_request','Allowed project roots must be directories');}
  const filesystem=await statfs(context.canonical),active=new Set(),lifetime=new AbortController();
  let closed=false,failure,pendingScans=0,scanTail=Promise.resolve();
  const totals={scans:0,bytesRead:0,filesHashed:0,nativeHints:0,overflows:0,lastScanMs:0,maxScanMs:0};
  function check(signal){if(closed)throw failure??workspaceFailure('disposed','Project observation port is disposed');projectAbort(context.signal);projectAbort(signal);}
  function options(value){const parsed=parseProjectWatchOptions(value);if(!roots.some(root=>projectContains(root,parsed.root)))throw workspaceFailure('permission_denied','Project root is outside the operator observation scope');return parsed;}
  function operationOptions(value={}){exactObject(value,[],['signal']);if(value.signal!==undefined&&!(value.signal instanceof AbortSignal))throw workspaceFailure('invalid_request','Expected AbortSignal');return value;}
  async function scan(parsed,value){
    value={...value,signal:AbortSignal.any([lifetime.signal,context.signal,...(value.signal?[value.signal]:[])])};
    check(value.signal);
    if(pendingScans>=8)throw workspaceFailure('budget_exceeded','Project scan queue is full');
    pendingScans++;const previous=scanTail;let release;scanTail=new Promise(resolve=>{release=resolve;});
    try{await previous;check(value.signal);const snapshot=await scanNodeProject(context,parsed,{...value,metrics:metric=>{totals.scans++;totals.bytesRead+=metric.bytesRead;totals.filesHashed+=metric.filesHashed;totals.lastScanMs=metric.durationMs;totals.maxScanMs=Math.max(totals.maxScanMs,metric.durationMs);}});check(value.signal);return snapshot;}
    finally{pendingScans--;release();}
  }
  function dispose(reason=workspaceFailure('disposed','Project observation port is disposed')){
    if(closed)return;closed=true;failure=reason;lifetime.abort(reason);context.signal.removeEventListener('abort',parentAbort);
    for(const observer of [...active])observer.stop(reason);
  }
  const parentAbort=()=>dispose(context.signal.reason);context.signal.addEventListener('abort',parentAbort,{once:true});
  if(context.signal.aborted){parentAbort();throw failure;}
  const port={
    capabilities:Object.freeze({version:1,supported:true,platform:process.platform,fileSystem:'local',filesystemType:String(filesystem.type),mode:'native-hints-with-reconciliation',rename:'delete-create',roots,limits:PROJECT_WATCH_LIMITS}),
    snapshot(value,request={}){const parsed=options(value);operationOptions(request);return scan(parsed,request);},
    watch(value,request={}){
      const parsed=options(value);operationOptions(request);check(request.signal);
      const controller=new AbortController(),subscriptionId=randomUUID(),handles=new Map(),queue=[];
      let started=false,ended=false,reading=false,running=false,runningPromise,again=false,waiting,error,delivered=false,cursor=0,previous,hintEpoch=0,hintsSinceScan=0,pendingReason,timer,interval,selectedRoot;
      const listeners=[];
      const state={handles,queue,stop};
      function stop(reason){
        if(ended)return;ended=true;error=reason;clearTimeout(timer);clearInterval(interval);
        controller.abort(reason??workspaceFailure('disposed','Project observer ended'));
        for(const record of handles.values())record.handle.close();handles.clear();queue.length=0;
        for(const [signal,listener] of listeners)signal.removeEventListener('abort',listener);
        active.delete(state);
        if(waiting){const pending=waiting;waiting=undefined;if(reason){delivered=true;pending.reject(reason);}else pending.resolve({done:true,value:undefined});}
      }
      function listen(signal,reason){if(!signal)return;const listener=()=>stop(reason());signal.addEventListener('abort',listener,{once:true});listeners.push([signal,listener]);if(signal.aborted)listener();}
      function deliver(event){
        if(ended)return;
        if(waiting){const pending=waiting;waiting=undefined;pending.resolve({done:false,value:event});return;}
        if(queue.length>=PROJECT_WATCH_LIMITS.queue){queue.length=0;totals.overflows++;event=parseProjectWatchEvent({...event,kind:'resync',changes:[],reason:'consumer_overflow'});}
        queue.push(event);
      }
      function schedule(){
        if(ended)return;clearTimeout(timer);timer=setTimeout(()=>{timer=undefined;void reconcile();},parsed.debounceMs);
      }
      function hint(filename){
        if(ended)return;hintEpoch++;totals.nativeHints++;
        hintsSinceScan=Math.min(1_025,hintsSinceScan+1);
        if(filename===null||filename===undefined)pendingReason='native_unknown';
        if(hintsSinceScan>1_024)pendingReason='native_overflow';
        schedule();
      }
      async function ensureWatch(relative,entry,seen){
        if(ended)return;seen.add(relative);
        if(relative===parsed.root){if(selectedRoot&&!sameIdentity(selectedRoot,entry.stat))throw workspaceFailure('unsafe_path','Observed root identity changed');selectedRoot??=entry.stat;}
        const old=handles.get(relative);
        if(old&&sameIdentity(old.stat,entry.stat))return;
        if(old){old.handle.close();handles.delete(relative);}
        let count=0;for(const observer of active)count+=observer.handles.size;
        if(count>=PROJECT_WATCH_LIMITS.nativeHandles){pendingReason='watcher_limit';return;}
        try{
          const handle=nativeWatch(entry.target,{recursive:false},(_kind,filename)=>hint(filename));
          const record={handle,stat:entry.stat};handles.set(relative,record);
          handle.on('error',()=>{if(ended)return;if(handles.get(relative)===record)handles.delete(relative);handle.close();pendingReason='native_unavailable';hintEpoch++;schedule();});
          const after=await context.resolve(relative,{allowRoot:true});
          if(!sameIdentity(after.stat,entry.stat)){handle.close();handles.delete(relative);throw workspaceFailure('unsafe_path','Observed directory identity changed');}
        }catch(error){if(error?.code==='unsafe_path')throw error;pendingReason='native_unavailable';}
      }
      function differences(before,after){
        const old=new Map(before.entries.map(x=>[x.path,x])),current=new Map(after.entries.map(x=>[x.path,x])),changes=[];
        for(const path of [...new Set([...old.keys(),...current.keys()])].sort()){
          const previous=old.get(path)??null,next=current.get(path)??null;
          if(previous&&next&&JSON.stringify(previous)===JSON.stringify(next))continue;
          changes.push({kind:previous===null?'created':next===null?'deleted':'changed',path,previous,current:next});
          if(changes.length>PROJECT_WATCH_LIMITS.changes)return null;
        }
        return changes;
      }
      async function reconcile(){
        if(ended)return;if(running){again=true;return;}running=true;
        runningPromise=(async()=>{
          try{
            check(controller.signal);const epoch=hintEpoch,seen=new Set();hintsSinceScan=0;
            const snapshot=await scan(parsed,{signal:controller.signal,onDirectory:(relative,entry)=>ensureWatch(relative,entry,seen)});
            if(ended)return;check(controller.signal);
            for(const [relative,record] of handles)if(!seen.has(relative)){record.handle.close();handles.delete(relative);}
            let reason=pendingReason;pendingReason=undefined;
            if(epoch!==hintEpoch)reason??=previous?'scan_changed':'initial_changed';
            if(!snapshot.complete)reason??='scan_incomplete';
            let changes=previous?differences(previous,snapshot):[];
            if(changes===null){reason??='change_limit';changes=[];}
            if(previous&&changes.length===0&&snapshot.revision!==previous.revision)reason??='scan_recovered';
            if(!previous||snapshot.revision!==previous.revision||reason){
              const event=parseProjectWatchEvent({version:1,subscriptionId,cursor:++cursor,kind:reason?'resync':previous?'changes':'snapshot',previousRevision:previous?.revision??null,snapshot,changes:reason?[]:changes,reason:reason??null});
              deliver(event);
            }
            previous=snapshot;
          }catch(failure){if(!ended)stop(projectFileError(failure));}
          finally{running=false;if(again&&!ended){again=false;schedule();}}
        })();
        await runningPromise;
      }
      function start(){
        if(started)return;check(request.signal);if(active.size>=PROJECT_WATCH_LIMITS.observers)throw workspaceFailure('budget_exceeded','Project observer limit exceeded');
        started=true;active.add(state);
        listen(context.signal,()=>context.signal.reason??workspaceFailure('disposed','Workspace is disposed'));
        listen(request.signal,()=>workspaceFailure('cancelled','Project observer cancelled'));
        if(ended)return;
        interval=setInterval(()=>void reconcile(),parsed.intervalMs);void reconcile();
      }
      const iterator={
        async next(){
          if(reading)throw workspaceFailure('conflict','Project observer already has a pending read');
          if(ended){if(error&&!delivered){delivered=true;throw error;}return{done:true,value:undefined};}
          reading=true;
          try{start();if(ended){if(error&&!delivered){delivered=true;throw error;}return{done:true,value:undefined};}if(queue.length)return{done:false,value:queue.shift()};const result=await new Promise((resolve,reject)=>{waiting={resolve,reject};});if(ended){if(error){delivered=true;throw error;}return{done:true,value:undefined};}check(controller.signal);return result;}
          catch(failure){stop(failure);delivered=true;throw failure;}
          finally{reading=false;}
        },
        async return(){stop();await runningPromise;return{done:true,value:undefined};},
        [Symbol.asyncIterator](){return iterator;},
      };
      return Object.freeze(iterator);
    },
    inspect(){return Object.freeze({...totals,pendingScans,observers:active.size,nativeHandles:[...active].reduce((sum,x)=>sum+x.handles.size,0),queuedEvents:[...active].reduce((sum,x)=>sum+x.queue.length,0),closed});},
    revoke(){dispose(workspaceFailure('permission_denied','Project observation permission was revoked'));},
    dispose(){dispose();},
  };
  return Object.freeze(port);
}
