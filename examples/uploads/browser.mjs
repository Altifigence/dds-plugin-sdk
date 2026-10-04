import {createWorkspaceClient} from '/sdk/workspace-client.mjs';
import {uploadFile} from '/sdk/uploads.mjs';
import {createBrowserUploadSource} from '/sdk/uploads-browser.mjs';
import {streamJobBinaryArtifact} from '/sdk/artifact-transfer.mjs';
import {createOpfsFileSink} from '/sdk/artifact-transfer-browser.mjs';
const config=await(await fetch('/config.json')).json(),status=document.querySelector('#status'),output=document.querySelector('#output'),progress=document.querySelector('#progress'),buttons=[...document.querySelectorAll('button')];
let file,selection;
function select(value){file=value;selection={uploadId:crypto.randomUUID(),pluginId:config.pluginId,artifactSha256:config.artifactSha256,path:'input/'+crypto.randomUUID()+'.bin',expectedRevision:null};document.querySelector('#selection').textContent=file.name+' · '+file.size+' bytes';document.querySelector('#cancel').disabled=false;document.querySelector('#resume').disabled=false;status.textContent='Selected';}
document.querySelector('#selected').onchange=event=>{if(event.target.files[0])select(event.target.files[0]);};
document.querySelector('#sample').onclick=()=>{const bytes=new Uint8Array(2_097_169);for(let n=0;n<bytes.length;n++)bytes[n]=(n*13+7)&255;select(new File([bytes],'dds-disposable-sample.bin'));};
function report(result){output.textContent=JSON.stringify(result,null,2);status.textContent=result.passed?'PASSED':result.cancelled?'CANCELLED':'FAILED';status.className=result.passed?'ok':'';}
async function run(cancel){
  buttons.forEach(b=>b.disabled=true);document.querySelector('#selected').disabled=true;status.textContent='Preparing';const client=createWorkspaceClient({url:config.url,token:config.token,timeoutMs:30000}),controller=new AbortController(),started=performance.now();let root,folder;
  try{
    await client.connect();const source=createBrowserUploadSource(file);let receipt;
    try{receipt=await uploadFile(client,source,{...selection,recover:!cancel,signal:controller.signal,onProgress:p=>{progress.max=p.total||1;progress.value=p.completed;status.textContent=p.phase+' · '+p.completed+' bytes';if(cancel&&p.phase==='uploading')controller.abort();}});}
    catch(error){if(!cancel||error.code!=='cancelled')throw error;const saved=await client.queryUpload({uploadId:selection.uploadId,pluginId:config.pluginId,artifactSha256:config.artifactSha256}),entries=(await client.listFiles('input')).entries;report({passed:saved.state==='receiving'&&saved.offset===Math.min(65536,file.size)&&!entries.some(e=>e.path===selection.path),cancelled:true,state:saved.state,savedBytes:saved.offset,wholeBytes:file.size,privatePartHidden:!entries.some(e=>e.path===selection.path)});return;}
    const job=await client.startCommandJob(config.pluginId,'collect',{path:selection.path},config.artifactSha256,{jobId:crypto.randomUUID()});const done=await client.waitForJob(job.jobId,{intervalMs:250});if(done.state!=='succeeded')throw Error('Collect failed');const reference=await client.getJobBinaryArtifact(job.jobId,'input');
    root=await navigator.storage.getDirectory();folder='dds-upload-example-'+crypto.randomUUID();const selected=await root.getDirectoryHandle(folder,{create:true}),sink=await createOpfsFileSink(selected,'verified.bin',{overwrite:false});
    const download=await streamJobBinaryArtifact(client,reference,{sink,onProgress:p=>{progress.max=p.totalBytes||1;progress.value=p.receivedBytes;status.textContent='download · '+p.receivedBytes+' bytes';}});
    report({passed:receipt.state==='committed'&&download.verification==='stored'&&download.storedSha256===receipt.commitReceipt.revision,runtime:navigator.userAgent,selectedBytes:file.size,uploadState:receipt.state,uploadSha256:receipt.commitReceipt.revision,downloadStoredSha256:download.storedSha256,downloadVerification:download.verification,downloadChunks:download.metrics.chunks,maxChunkWorkMs:download.metrics.maxChunkWorkMs,elapsedMs:Math.round(performance.now()-started)});
  }catch(error){report({passed:false,code:error.code,message:error.message});}
  finally{client.dispose();if(root&&folder)await root.removeEntry(folder,{recursive:true});buttons.forEach(b=>b.disabled=false);document.querySelector('#selected').disabled=false;}
}
document.querySelector('#cancel').onclick=()=>run(true);document.querySelector('#resume').onclick=()=>run(false);
document.querySelector('#stop').onclick=async()=>{const response=await fetch('/close',{method:'POST',headers:{'x-fixture-token':config.token}});status.textContent=response.ok?'Fixture stopped':'Stop failed';buttons.forEach(b=>b.disabled=true);};
