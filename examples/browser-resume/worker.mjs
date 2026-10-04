import {createWorkspaceClient} from '/sdk/workspace-client.mjs';
import {createTransferQueue} from '/sdk/transfer-queue.mjs';
import {createOpfsArtifactSink,getBrowserArtifactResumeSupport,parseBrowserArtifactCheckpoint} from '/sdk/artifact-resume-browser.mjs';
let queue,job,running=false;
onmessage=async({data})=>{
  if(data.action==='cancel'){job?.cancel();return;}
  if(data.action==='continue'){job?.resume();return;}
  if(running)return;running=true;
  const {config,selection,action}=data,client=createWorkspaceClient({url:config.url,token:config.token});
  try{
    const support=getBrowserArtifactResumeSupport();if(!support.supported)throw Object.assign(new Error('Dedicated Worker OPFS sync access and Web Locks required'),{code:'unsupported'});
    // The UI explicitly selects this fixture-owned directory and UUID. No credential is persisted.
    const root=await navigator.storage.getDirectory(),directory=await root.getDirectoryHandle(selection.directory,{create:action!=='resume'});
    await client.connect();const reference=await client.getStoredJobArtifact(config.pluginId,config.jobId,config.artifactId,config.artifactSha256),sink=createOpfsArtifactSink({directory,partialId:selection.partialId,reference});
    queue=createTransferQueue({concurrency:1,perConnection:1});let stopped=false;
    queue.subscribe(value=>{postMessage({progress:value});});
    job=queue.enqueueStoredDownload(client,reference,{sink,resume:action==='resume',onProgress:p=>{
      if(!stopped&&p.receivedBytes>=65536&&(action==='checkpoint'||action==='hold')){stopped=true;if(action==='checkpoint')job.cancel();else{job.pause();postMessage({holding:true,partialId:selection.partialId,generation:reference.scope.sessionId,checkpointBytes:p.writtenBytes});}}
    }});
    const receipt=await job.result,metadata=parseBrowserArtifactCheckpoint(JSON.parse(await (await directory.getFileHandle(sink.names.metadata)).getFile().then(file=>file.text())));
    postMessage({passed:receipt.verification==='stored'&&receipt.storedSha256===config.sha256,support,runtime:navigator.userAgent,partialId:selection.partialId,generation:reference.scope.sessionId,receipt,metadata});
  }catch(error){postMessage({passed:false,code:error.code??error.name,message:error.message,partial:error.partial,checkpointRetained:error.code==='cancelled'&&error.partial?.disposition==='retained'});}
  finally{await queue?.dispose();queue=job=undefined;client.dispose();running=false;postMessage({idle:true});}
};
