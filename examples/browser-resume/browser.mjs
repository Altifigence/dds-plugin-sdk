let config=await (await fetch('/config.json')).json();const key='dds-resume-fixture:'+config.fixtureId;
const elements=Object.fromEntries(['checkpoint','hold','resume','continue','cancel','restart','reload','cleanup','close','selection','progress','status','output'].map(id=>[id,document.getElementById(id)]));
let worker,busy=false,lastProgress,selection=JSON.parse(localStorage.getItem(key)??'null');
const renderSelection=()=>{elements.selection.textContent=selection?`Selected partial: ${selection.partialId}`:'No partial selected. Create a checkpoint first.';};renderSelection();
window.addEventListener('storage',event=>{if(event.key===key&&!busy){selection=JSON.parse(event.newValue??'null');renderSelection();}});
function state(running){busy=running;for(const id of ['checkpoint','hold','resume','restart','cleanup','close'])elements[id].disabled=running;elements.cancel.disabled=!running;elements.continue.disabled=!running;}
async function run(action){
  if(busy)return;
  if(action!=='resume'){
    if(selection){elements.status.textContent='Remove the selected fixture files before creating another partial.';return;}
    selection={partialId:crypto.randomUUID(),directory:'dds-resume-fixture-'+config.fixtureId};localStorage.setItem(key,JSON.stringify(selection));renderSelection();
  }
  if(!selection){elements.status.textContent='Create or select a checkpoint first.';return;}
  state(true);config=await (await fetch('/config.json')).json();worker?.terminate();worker=new Worker('/worker.mjs',{type:'module'});
  elements.status.textContent='Connecting with current authority…';
  worker.onmessage=({data})=>{
    if(data.progress){lastProgress=data.progress;elements.progress.value=(data.progress.totalBytes?data.progress.acknowledgedBytes/data.progress.totalBytes:0);elements.status.textContent=`${data.progress.state} · ${data.progress.phase} · ${data.progress.acknowledgedBytes} / ${data.progress.totalBytes} bytes`;return;}
    if(data.idle){state(false);return;}
    elements.output.textContent=JSON.stringify(data,null,2);
    if(data.holding)elements.status.textContent='PAUSED — checkpoint saved; this Worker still owns the lock. A second tab must receive conflict.';
    else if(data.checkpointRetained)elements.status.textContent='CHECKPOINT RETAINED — reload or reopen, then resume.';
    else elements.status.textContent=data.passed?'PASSED — whole saved file SHA-256 verified':`FAILED — ${data.code}: ${data.message}`;
  };
  worker.onerror=event=>{elements.status.textContent='Worker failed: '+event.message;state(false);};worker.postMessage({action,selection,config});
}
for(const id of ['checkpoint','hold','resume'])elements[id].onclick=()=>void run(id).catch(error=>{elements.status.textContent=error.message;state(false);});
elements.continue.onclick=()=>worker?.postMessage({action:'continue'});elements.cancel.onclick=()=>worker?.postMessage({action:'cancel'});
elements.reload.onclick=()=>location.reload();
elements.restart.onclick=async()=>{config=await(await fetch('/config.json')).json();const r=await fetch('/restart',{method:'POST',headers:{'x-fixture-token':config.token}});elements.status.textContent=r.ok?'HOST RESTARTED — resume obtains a new approved reference.':'Host restart failed';};
elements.cleanup.onclick=async()=>{
  if(!selection)return;try{
    await navigator.locks.request('dds-artifact-partial:'+selection.partialId,{mode:'exclusive',ifAvailable:true},async lock=>{
      if(!lock)throw Error('Another tab owns this partial; close or cancel that transfer first.');
      worker?.terminate();const root=await navigator.storage.getDirectory();
      if(selection.directory!=='dds-resume-fixture-'+config.fixtureId||!/^[0-9a-f-]{36}$/.test(selection.partialId))throw Error('Unexpected fixture selection');
      const directory=await root.getDirectoryHandle(selection.directory);for(const suffix of ['data','json'])await directory.removeEntry('dds-partial-'+selection.partialId+'.'+suffix).catch(error=>{if(error.name!=='NotFoundError')throw error;});
      // Remove only an empty fixture directory; preserve any unrelated entry.
      await root.removeEntry(selection.directory).catch(error=>{if(!['InvalidModificationError','NotFoundError'].includes(error.name))throw error;});
      localStorage.removeItem(key);selection=null;renderSelection();elements.status.textContent='Selected fixture files removed.';
    });
  }catch(error){elements.status.textContent=error.message;}
};
elements.close.onclick=async()=>{config=await(await fetch('/config.json')).json();worker?.terminate();const r=await fetch('/close',{method:'POST',headers:{'x-fixture-token':config.token}});elements.status.textContent=r.ok?'Fixture stopped.':'Fixture stop failed.';};
