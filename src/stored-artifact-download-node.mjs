import {storageEqual} from './job-storage-validation.mjs';
import {downloadJobBinaryArtifact} from './artifact-download-node.mjs';
import {parseStoredArtifactReference} from './artifact-storage.mjs';
import {workspaceFailure} from './workspace-protocol.mjs';

/** Reuses the verified bounded downloader, with current snapshot identity checked on every request. */
export async function downloadStoredJobArtifact(client,value,options){
  const reference=parseStoredArtifactReference(value),s=reference.snapshot;
  if(!client||['getArtifactStorageCapabilities','getStoredJobArtifact','readStoredJobArtifactChunk'].some(key=>typeof client[key]!=='function'))throw workspaceFailure('invalid_request','A connected storage client is required');
  const legacy={jobId:s.jobId,scope:reference.scope,artifact:s.artifact};
  const bridge={
    get binding(){return client.binding;},
    async getBinaryArtifactCapabilities(requestOptions){const caps=await client.getArtifactStorageCapabilities(requestOptions);return{protocolVersion:1,enabled:caps.enabled,limits:{fileBytes:caps.limits.fileBytes,chunkBytes:caps.limits.chunkBytes,artifacts:16,concurrent:caps.limits.concurrent}};},
    async getJobBinaryArtifact(_jobId,_artifactId,requestOptions){
      const current=parseStoredArtifactReference(await client.getStoredJobArtifact(s.pluginId,s.jobId,s.artifact.id,s.pluginArtifactSha256,requestOptions));
      if(!storageEqual(current,reference))throw workspaceFailure('conflict','Stored artifact identity changed');return legacy;
    },
    async readJobBinaryArtifactChunk(_reference,offset,requestOptions){
      const result=await client.readStoredJobArtifactChunk(reference,offset,requestOptions);
      if(!storageEqual(result.reference,reference))throw workspaceFailure('conflict','Stored artifact identity changed');
      const{reference:_ignored,...chunk}=result;return{...legacy,...chunk};
    },
  };
  const result=await downloadJobBinaryArtifact(bridge,legacy,options);
  return Object.freeze({...result,storage:'snapshot',snapshotId:s.snapshotId,storeId:s.storeId});
}
