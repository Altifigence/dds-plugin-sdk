import {openOwnedJsonStore} from './owned-json-store-node.mjs';
import {parseWorkflowRecord,WORKFLOW_LIMITS} from './workflows.mjs';
import {canonical,fail,integer,jsonCopy} from './workflow-internals.mjs';

export async function createNodeWorkflowStore(options) {
  const binding=jsonCopy(options.scope);
  const storage=await openOwnedJsonStore({...options,scope:binding,kind:'workflows-v1',maxEntries:WORKFLOW_LIMITS.records,maxBytes:33_554_432,recordBytes:WORKFLOW_LIMITS.recordBytes});
  let tail=Promise.resolve();
  return Object.freeze({
    async read(id){const value=await storage.get(id);return value?parseWorkflowRecord(value):null;},
    async list(){const result=[];for(const id of await storage.list()){const value=await storage.get(id);if(value)result.push(parseWorkflowRecord(value));}return Object.freeze(result);},
    async write(input,expectedRevision){
      const r=parseWorkflowRecord(input);integer(expectedRevision,0,Number.MAX_SAFE_INTEGER);
      if(canonical(r.scope)!==canonical(binding))fail('DENIED','Workflow scope differs from store');
      const pending=tail.then(async()=>{const old=await storage.get(r.attemptId);if((old?.revision??0)!==expectedRevision||r.revision!==expectedRevision+1)fail('CONFLICT','Workflow checkpoint changed');await storage.set(r.attemptId,r);});
      tail=pending.catch(()=>{});return pending;
    },
    async cleanup({expiredBefore=0}={}){
      integer(expiredBefore,0,Number.MAX_SAFE_INTEGER);
      const pending=tail.then(async()=>{
        const removed=[];
        for(const id of await storage.list()){
          const value=await storage.get(id);if(!value)continue;const record=parseWorkflowRecord(value);
          if(!['pending','running'].includes(record.state)&&record.expiresAt<=expiredBefore&&await storage.remove(id))removed.push(id+'.json');
        }
        const recovery=await storage.cleanup();return {removed:[...removed,...recovery.removed],preserved:recovery.preserved};
      });tail=pending.catch(()=>{});return pending;
    },inspect:()=>storage.inspect(),async close(){await tail;await storage.close();},
  });
}
