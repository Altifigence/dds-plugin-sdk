import {createWorkspaceClient} from '/sdk/workspace-client.mjs';
import {streamJobBinaryArtifact} from '/sdk/artifact-transfer.mjs';
import {createOpfsFileSink,getBrowserArtifactStorageSupport} from '/sdk/artifact-transfer-browser.mjs';
let controller;
onmessage=async event=>{
  if(event.data.cancel){controller?.abort();return;}
  const {config}=event.data;controller=new AbortController();const client=createWorkspaceClient(config);let root,name;
  try{
    root=await navigator.storage.getDirectory();name='dds-worker-example-'+crypto.randomUUID();const directory=await root.getDirectoryHandle(name,{create:true}),sink=await createOpfsFileSink(directory,'trace.bin',{overwrite:false});await client.connect();
    const receipt=await streamJobBinaryArtifact(client,config.reference,{sink,signal:controller.signal,onProgress:progress=>postMessage({progress})});
    // Remove the fixture before posting completion; a consumer may terminate this Worker.
    await root.removeEntry(name,{recursive:true});name=undefined;
    postMessage({passed:receipt.verification==='stored'&&receipt.storedSha256===config.sha256,worker:true,runtime:navigator.userAgent,support:getBrowserArtifactStorageSupport(),receipt});
  }catch(error){if(root&&name){await root.removeEntry(name,{recursive:true}).catch(()=>{});name=undefined;}postMessage({passed:false,code:error.code,message:error.message,partial:error.partial});}
  finally{client.dispose();}
};
