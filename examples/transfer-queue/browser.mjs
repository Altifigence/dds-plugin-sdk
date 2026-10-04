import {createTransferQueue} from '/sdk/transfer-queue.mjs';
import {createWorkspaceClient} from '/sdk/workspace-client.mjs';
import {createBrowserUploadSource} from '/sdk/uploads-browser.mjs';
import {createOpfsFileSink} from '/sdk/artifact-transfer-browser.mjs';
const config=await(await fetch('/config.json')).json(),status=document.querySelector('#status'),output=document.querySelector('#output'),rows=document.querySelector('#rows'),runButton=document.querySelector('#run'),resumeButton=document.querySelector('#resume'),cancelButton=document.querySelector('#cancel'),stopButton=document.querySelector('#stop');let queue,upload;
resumeButton.onclick=()=>{upload.resume();resumeButton.disabled=true;status.textContent='Resuming upload';};cancelButton.onclick=()=>{void queue.dispose();};
runButton.onclick=async()=>{
  runButton.disabled=true;stopButton.disabled=true;cancelButton.disabled=false;status.textContent='Preparing';rows.replaceChildren();const started=performance.now(),finished={},labels=new Map(),table=new Map();let root,folder,client,paused=false,lostWrite=false,rejectedRead=false;
  queue=createTransferQueue({concurrency:2,perConnection:2,bufferBytes:131072,baseDelayMs:100,maxDelayMs:500});
  try{
    client=createWorkspaceClient({url:config.url,token:config.token,timeoutMs:30000,fetch:async(url,options)=>{
      const request=JSON.parse(options.body);if(request.method==='artifacts.read'&&!rejectedRead){rejectedRead=true;return new Response('',{status:503});}
      const response=await fetch(url,options);if(request.method==='uploads.write'&&!lostWrite){lostWrite=true;await response.json();throw Error('Disposable lost acknowledgement fixture');}return response;
    }});await client.connect();root=await navigator.storage.getDirectory();folder='dds-queue-example-'+crypto.randomUUID();const directory=await root.getDirectoryHandle(folder,{create:true});
    const largeSink=await createOpfsFileSink(directory,'large.bin',{overwrite:false}),smallSink=await createOpfsFileSink(directory,'small.bin',{overwrite:false});
    queue.subscribe(s=>{
      let row=table.get(s.id);if(!row){row=document.createElement('tr');for(let i=0;i<5;i++)row.append(document.createElement('td'));table.set(s.id,row);rows.append(row);}
      const values=[labels.get(s.id)??s.kind,s.state,s.acknowledgedBytes+' / '+s.totalBytes,s.retriedBytes,s.verified?s.verification:'Pending'];values.forEach((v,i)=>row.children[i].textContent=String(v));
      if(upload?.id===s.id&&!paused&&s.phase==='uploading'&&s.acknowledgedBytes>=65536){paused=true;upload.pause();resumeButton.disabled=false;status.textContent='Upload paused after first saved chunk. Other downloads continue.';}
    });
    const bytes=new Uint8Array(config.fileBytes);for(let n=0;n<bytes.length;n++)bytes[n]=(n*13+7)&255;
    const large=queue.enqueueDownload(client,config.large,{sink:largeSink});labels.set(large.id,'Large download');
    upload=queue.enqueueUpload(client,createBrowserUploadSource(new File([bytes],'generated-input.bin')),{uploadId:crypto.randomUUID(),pluginId:config.pluginId,artifactSha256:config.artifactSha256,path:'input/'+crypto.randomUUID()+'.bin',expectedRevision:null});labels.set(upload.id,'Selected File upload');
    const small=queue.enqueueDownload(client,config.small,{sink:smallSink});labels.set(small.id,'Small download');
    for(const [name,h]of Object.entries({large,small,upload}))h.result.then(()=>{finished[name]=Math.round(performance.now()-started);},()=>{});
    const [download,committed]=await Promise.all([large.result,upload.result,small.result]);const passed=download.storedSha256===config.sha256&&committed.commitReceipt.revision===config.sha256&&paused&&finished.small<finished.large&&upload.snapshot.retriedBytes===65536&&large.snapshot.retriedBytes===65536;
    output.textContent=JSON.stringify({passed,runtime:navigator.userAgent,fileBytes:config.fileBytes,finishedMs:finished,pausedAndResumed:paused,upload:upload.snapshot,download:large.snapshot,queue:queue.inspect(),elapsedMs:Math.round(performance.now()-started)},null,2);status.textContent=passed?'PASSED':'FAILED';status.className=passed?'ok':'';
  }catch(error){status.textContent=error.code==='cancelled'?'CANCELLED':'FAILED';output.textContent=JSON.stringify({code:error.code,message:error.message,transfers:queue.list()},null,2);}
  finally{await queue.dispose();client?.dispose();if(root&&folder)await root.removeEntry(folder,{recursive:true});resumeButton.disabled=true;cancelButton.disabled=true;runButton.disabled=false;stopButton.disabled=false;}
};
stopButton.onclick=async()=>{const response=await fetch('/close',{method:'POST',headers:{'x-fixture-token':config.token}});status.textContent=response.ok?'Fixture stopped':'Stop failed';for(const button of document.querySelectorAll('button'))button.disabled=true;};
