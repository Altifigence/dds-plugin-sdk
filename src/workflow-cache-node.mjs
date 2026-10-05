import {openOwnedJsonStore} from './owned-json-store-node.mjs';
import {parseWorkflowCacheEntry} from './workflow-cache.mjs';
import {canonical,fail,sha,jsonCopy} from './workflow-internals.mjs';

export async function createNodeWorkflowCacheStore(options) {
  const binding=jsonCopy(options.scope);
  const storage=await openOwnedJsonStore({...options,scope:binding,kind:'workflow-cache-v1',maxEntries:512,maxBytes:67_108_864,recordBytes:131_072});
  return Object.freeze({
    async get(key){const r=await storage.get(sha(key));return r?parseWorkflowCacheEntry(r):null;},
    async set(key,input){const r=parseWorkflowCacheEntry(input);if(r.key!==sha(key)||canonical(r.scope)!==canonical(binding))fail('DENIED','Cache scope or key changed');await storage.set(key,r);},
    list:()=>storage.list(),remove:key=>storage.remove(sha(key)),cleanup:()=>storage.cleanup(),inspect:()=>storage.inspect(),close:()=>storage.close(),
  });
}
