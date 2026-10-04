import {createNodeProjectWatcher} from './project-watch-node.mjs';
import {createNodeProjectQueries} from './project-query-node.mjs';
import {WORKSPACE_PROJECT_LIMITS,parseWorkspaceProjectCapabilities,parseWorkspaceProjectPoll} from './workspace-project-contracts.mjs';
import {exactObject,workspaceFailure} from './workspace-values.mjs';

/** Private HTTP resource owner; one configured token shares these bounded ports. */
export async function createWorkspaceProjectTransport(workspace,configuration,scope){
  let watcher,queries,closed=false,revoked=false;
  const subscriptions=new Map(),closures=new Set();
  let limits=WORKSPACE_PROJECT_LIMITS;
  if(configuration!==undefined){
    exactObject(configuration,['roots','fileSystem'],['leaseMs']);
    const leaseMs=configuration.leaseMs??WORKSPACE_PROJECT_LIMITS.leaseMs;
    if(!Number.isSafeInteger(leaseMs)||leaseMs<WORKSPACE_PROJECT_LIMITS.minLeaseMs||leaseMs>WORKSPACE_PROJECT_LIMITS.leaseMs)throw workspaceFailure('invalid_request','Invalid project subscription lease');
    limits=Object.freeze({...WORKSPACE_PROJECT_LIMITS,leaseMs});
    watcher=await createNodeProjectWatcher({workspace,roots:configuration.roots,fileSystem:configuration.fileSystem});
    try{queries=createNodeProjectQueries({watcher});}catch(error){watcher.dispose();throw error;}
  }
  function check(signal){if(closed)throw workspaceFailure('disposed','Workspace project transport is disposed');if(revoked)throw workspaceFailure('permission_denied','Project access was revoked');if(!watcher)throw workspaceFailure('unsupported','Project tools are disabled');if(signal?.aborted)throw signal.reason;}
  function stop(record,reason){
    if(!record||record.closed)return false;record.closed=true;subscriptions.delete(record.id);clearTimeout(record.timer);
    record.controller.abort(reason??workspaceFailure('disposed','Project subscription stopped'));
    const cleanup=record.iterator.return().catch(()=>{});closures.add(cleanup);void cleanup.finally(()=>closures.delete(cleanup));
    return true;
  }
  function renew(record){clearTimeout(record.timer);record.expiresAt=Date.now()+limits.leaseMs;record.timer=setTimeout(()=>stop(record,workspaceFailure('not_found','Project subscription lease expired')),limits.leaseMs);record.timer.unref?.();}
  function result(record,after,event){return parseWorkspaceProjectPoll({scope,subscriptionId:record.id,after,event,expiresAt:record.expiresAt});}
  async function withRecord(record,signal,operation){
    if(record.busy)throw workspaceFailure('conflict','Project subscription already has a pending poll');
    record.busy=true;clearTimeout(record.timer);
    const abort=()=>stop(record,signal.reason);signal.addEventListener('abort',abort,{once:true});
    try{check(signal);const value=await operation();check(signal);if(record.closed)throw workspaceFailure('not_found','Project subscription ended');return value;}
    catch(error){stop(record,error);throw error;}
    finally{record.busy=false;signal.removeEventListener('abort',abort);}
  }
  return Object.freeze({
    capabilities(){return parseWorkspaceProjectCapabilities({protocolVersion:1,enabled:!!watcher&&!closed&&!revoked,scope,watch:watcher&&!closed&&!revoked?watcher.capabilities:null,query:queries&&!closed&&!revoked?queries.capabilities:null,limits});},
    async dispatch(method,p,signal){
      if(method==='projects.capabilities')return this.capabilities();check(signal);
      if(method==='projects.snapshot')return{scope,snapshot:await watcher.snapshot(p.options,{signal})};
      if(method==='projects.query'){
        const {kind,...query}=p.query;const action=kind==='tree'?'listTree':kind==='files'?'searchFiles':'searchText';return{scope,page:await queries[action](query,{signal})};
      }
      if(method==='projects.query.release')return{scope,released:queries.releaseCursor(p.cursor)};
      if(method==='projects.watch.stop')return{scope,stopped:stop(subscriptions.get(p.subscriptionId))};
      if(method==='projects.watch.start'){
        if(subscriptions.has(p.subscriptionId))throw workspaceFailure('conflict','Project subscription ID is already active');
        if(subscriptions.size>=limits.subscriptions)throw workspaceFailure('budget_exceeded','Project subscription capacity exceeded');
        const controller=new AbortController(),iterator=watcher.watch(p.options,{signal:controller.signal});
        const record={id:p.subscriptionId,controller,iterator,busy:false,closed:false,last:undefined,pending:undefined,expiresAt:0,timer:undefined};
        subscriptions.set(record.id,record);
        return withRecord(record,signal,async()=>{const first=await iterator.next();if(first.done)throw workspaceFailure('not_found','Project subscription ended before its snapshot');record.last=first.value;renew(record);return result(record,0,record.last);});
      }
      const record=subscriptions.get(p.subscriptionId);if(!record||!record.busy&&Date.now()>=record.expiresAt){stop(record);throw workspaceFailure('not_found','Project subscription lease expired or ID is unknown');}
      if(!record.last||p.after>record.last.cursor)throw workspaceFailure('invalid_request','Project subscription cursor is ahead of the host');
      return withRecord(record,signal,async()=>{
        if(p.after<record.last.cursor){renew(record);return result(record,p.after,record.last);}
        record.pending??=record.iterator.next().then(value=>({value}),error=>({error}));
        let timer;const timeout=Symbol('poll timeout');
        try{
          const next=await Promise.race([record.pending,new Promise(resolve=>{timer=setTimeout(()=>resolve(timeout),p.waitMs);})]);
          if(next===timeout){renew(record);return result(record,p.after,null);}
          record.pending=undefined;if(next.error)throw next.error;if(next.value.done)throw workspaceFailure('not_found','Project subscription ended');
          record.last=next.value.value;renew(record);return result(record,p.after,record.last);
        }finally{clearTimeout(timer);}
      });
    },
    revoke(){if(revoked||closed)return;revoked=true;for(const record of [...subscriptions.values()])stop(record,workspaceFailure('permission_denied','Project access was revoked'));queries?.revoke();watcher?.revoke();},
    async close(){if(closed)return;closed=true;for(const record of [...subscriptions.values()])stop(record);queries?.dispose();watcher?.dispose();await Promise.allSettled([...closures]);},
  });
}
