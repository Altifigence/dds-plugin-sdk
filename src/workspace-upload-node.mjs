import {createNodeUploadStore} from './uploads-node.mjs';
import {DEFAULT_UPLOAD_LIMITS,parseUploadCapabilities} from './uploads.mjs';
import {exactObject,workspaceFailure} from './workspace-values.mjs';
export async function createWorkspaceUploadTransport(workspace,configuration,scope,authorize){
  let store;
  if(configuration!==undefined){exactObject(configuration,['directory','principalId','roots','fileSystem'],['limits','recoverStaleLock']);store=await createNodeUploadStore({workspace,scope,authorize,...configuration});}
  const disabled=()=>parseUploadCapabilities({protocolVersion:1,enabled:false,scope,identity:null,roots:[],limits:DEFAULT_UPLOAD_LIMITS,profile:'local-node-v1'});
  return Object.freeze({
    async dispatch(method,p,signal){
      if(method==='uploads.capabilities')return store?store.capabilities():disabled();
      if(!store)throw workspaceFailure('unsupported','Uploads are not enabled on this host');
      const options={signal};
      if(method==='uploads.begin')return store.begin(p.spec,options);
      if(method==='uploads.query')return store.query(p.query,options);
      if(method==='uploads.write')return store.write(p.reference,p.chunk,options);
      if(method==='uploads.commit')return store.commit(p.reference,options);
      if(method==='uploads.abort')return store.abort(p.reference,options);
      throw workspaceFailure('unsupported','Unknown upload operation');
    },
    revoke(){store?.revoke();},async close(){await store?.close();},
  });
}
