import {createWorkspaceClient} from '/sdk/workspace-client.mjs';
import {streamJobBinaryArtifact} from '/sdk/artifact-transfer.mjs';
import {createOpfsFileSink,createBrowserFileSink,getBrowserArtifactStorageSupport} from '/sdk/artifact-transfer-browser.mjs';

const config=await(await fetch('/config.json')).json(),output=document.querySelector('#output'),status=document.querySelector('#status'),progress=document.querySelector('#progress');
const buttons=[...document.querySelectorAll('button:not(#stop)')],stop=document.querySelector('#stop');let controller,worker;
const setBusy=busy=>{buttons.forEach(button=>button.disabled=busy);stop.disabled=!busy;};
function show(result){output.textContent=JSON.stringify(result,null,2);status.textContent=result.passed?'PASSED':result.cancelled?'CANCELLED':'FAILED';status.className=result.passed?'ok':'';setBusy(false);}
function update(value){progress.max=value.totalBytes||1;progress.value=value.receivedBytes;status.textContent=value.phase+' · '+value.receivedBytes+' bytes';}
async function run({cancel=false,picker=false}={}){
  setBusy(true);status.textContent='Preparing';controller=new AbortController();const client=createWorkspaceClient(config);
  let originRoot,folderName,sink;
  const longTasks=[];let observer;const heapBefore=performance.memory?.usedJSHeapSize??null;let heapPeak=heapBefore;
  const sample=setInterval(()=>{if(heapPeak!==null)heapPeak=Math.max(heapPeak,performance.memory.usedJSHeapSize);},10);
  try{
    if(PerformanceObserver.supportedEntryTypes.includes('longtask')){observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(entry=>entry.duration)));observer.observe({type:'longtask'});}
    if(picker){if(typeof showSaveFilePicker!=='function')throw new Error('File picker unsupported');const handle=await showSaveFilePicker({suggestedName:'dds-trace.bin'});sink=createBrowserFileSink(handle,{overwrite:true});}
    else{originRoot=await navigator.storage.getDirectory();folderName='dds-example-'+crypto.randomUUID();const selected=await originRoot.getDirectoryHandle(folderName,{create:true});sink=await createOpfsFileSink(selected,'trace.bin',{overwrite:false});}
    await client.connect();
    const receipt=await streamJobBinaryArtifact(client,config.reference,{sink,signal:controller.signal,onProgress:value=>{update(value);if(cancel&&value.phase==='receiving')controller.abort();}});
    show({passed:receipt.storedSha256===config.sha256&&receipt.verification==='stored',runtime:navigator.userAgent,support:getBrowserArtifactStorageSupport(),receipt,heapDeltaBytes:heapPeak===null?null:heapPeak-heapBefore,longTaskCount:longTasks.length,maxLongTaskMs:Math.max(0,...longTasks),visibility:document.visibilityState});
  }catch(error){show({passed:cancel&&error.code==='cancelled'&&error.partial?.commit==='not-committed',cancelled:error.code==='cancelled',code:error.code,message:error.message,partial:error.partial});}
  finally{client.dispose();observer?.disconnect();clearInterval(sample);if(originRoot&&folderName)await originRoot.removeEntry(folderName,{recursive:true});setBusy(false);}
}
document.querySelector('#run').onclick=()=>run();document.querySelector('#cancel-test').onclick=()=>run({cancel:true});document.querySelector('#pick').onclick=()=>run({picker:true});
document.querySelector('#worker').onclick=()=>{
  setBusy(true);worker=new Worker('/worker.mjs',{type:'module'});worker.onmessage=event=>{if(event.data.progress)update(event.data.progress);else{show(event.data);worker.terminate();worker=undefined;}};worker.onerror=event=>{show({passed:false,message:event.message});worker.terminate();worker=undefined;};worker.postMessage({config});
};
stop.onclick=()=>{controller?.abort();worker?.postMessage({cancel:true});};
