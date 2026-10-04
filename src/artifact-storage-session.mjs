import {storageEqual} from './job-storage-validation.mjs';
import {ARTIFACT_STORE_LIMITS,parseArtifactStoreLimits,parseStoredArtifact,parseStoredArtifactList,parseArtifactStorageCapabilities} from './artifact-storage.mjs';
import {parseJobStoreIdentity} from './job-storage.mjs';
import {ErrorCode,PluginSdkError} from './limits.mjs';

const failure=code=>new PluginSdkError(code,'Stored artifact operation failed');
export function createArtifactStorageSession(identity,store){
  if(store===undefined)return Object.freeze({
    enabled:false,capabilities:()=>parseArtifactStorageCapabilities({protocolVersion:1,enabled:false,identity:null,limits:ARTIFACT_STORE_LIMITS}),
    capture:async()=>{},list(){throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);},verify(){throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);},readChunk(){throw failure(ErrorCode.CAPABILITY_UNAVAILABLE);},
  });
  if(!identity||!store||typeof store!=='object'||['capture','status','verify','readChunk'].some(key=>typeof store[key]!=='function'))throw failure(ErrorCode.INVALID_CONTRACT);
  const bound=parseJobStoreIdentity(store.identity),limits=parseArtifactStoreLimits(store.limits);
  if(!storageEqual(bound,identity))throw failure(ErrorCode.CONFLICT);
  return Object.freeze({
    enabled:true,capabilities:()=>parseArtifactStorageCapabilities({protocolVersion:1,enabled:true,identity,limits}),
    async capture(r,kind,artifact,source,pluginArtifactSha256,signal){
      const {label:_label,...metadata}=artifact;
      const stored=parseStoredArtifact(await store.capture({jobId:r.jobId,pluginId:r.pluginId,pluginArtifactSha256,kind,artifact:metadata},source,{signal,timeoutMs:r.timeoutMs}));
      if(stored.storeId!==identity.storeId||stored.workspaceId!==identity.workspaceId||stored.workspaceIdentity!==identity.workspaceIdentity||stored.jobId!==r.jobId||stored.pluginId!==r.pluginId||stored.pluginArtifactSha256!==pluginArtifactSha256||stored.kind!==kind||!storageEqual(stored.artifact,metadata))throw failure(ErrorCode.INVALID_CONTRACT);
      return stored;
    },
    list(pluginId,pluginArtifactSha256,recovery){
      const items=[];
      if(recovery.record){
        for(const [kind,sources]of [['text',recovery.record.snapshot.artifacts],['binary',recovery.record.binaryArtifacts]])for(const artifact of sources){
          const snapshot=recovery.record.retainedArtifacts?.find(s=>s.artifact.id===artifact.id)??null;
          items.push({kind,artifact,storage:snapshot?'snapshot':'source',availability:snapshot?store.status(snapshot):'source-reference',snapshot});
        }
      }
      return parseStoredArtifactList({protocolVersion:1,scope:recovery.scope,storeId:identity.storeId,jobId:recovery.jobId,pluginId,pluginArtifactSha256,disposition:recovery.disposition,artifacts:items});
    },
    async verify(snapshot,options){const verified=parseStoredArtifact(await store.verify(snapshot,options));if(!storageEqual(verified,snapshot))throw failure(ErrorCode.CONFLICT);return verified;},
    readChunk:(snapshot,offset,length,options)=>store.readChunk(snapshot,offset,length,options),
  });
}
