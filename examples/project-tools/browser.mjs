import {createWorkspaceClient,createWorkspaceProject} from '@altifigence/dds-plugin-sdk/workspace-client';

const button=document.querySelector('#run'),status=document.querySelector('#status'),log=document.querySelector('#log'),draft=document.querySelector('#draft');
const assert=(condition,message)=>{if(!condition)throw new Error(message);log.textContent+=message+'\n';};
button.addEventListener('click',async()=>{
  button.disabled=true;status.textContent='Running';log.textContent='';let client,external,project,observer;
  try{
    const config=await(await fetch('/config.json',{cache:'no-store'})).json();
    client=createWorkspaceClient(config);external=createWorkspaceClient(config);await client.connect();await external.connect();project=createWorkspaceProject(client);
    assert((await project.getProjectCapabilities()).enabled,'Project capability and explicit rtl scope discovered.');
    const file='rtl/example-'+crypto.randomUUID()+'.sv';const edit=await project.createFile(file,'module browser_example; endmodule\n'),original=edit.snapshot;
    draft.value=original.content+'// unsaved browser draft\n';
    const query={root:'rtl',include:[file.slice(4)],query:'module '};const page=await project.searchText(query);assert(page.total===1,'Created file found with a content revision and UTF-16 range.');
    observer=project.watchProject({root:'rtl',include:query.include,intervalMs:250,debounceMs:20},{timeoutMs:30000});const first=(await observer.next()).value;assert(first.cursor===1,'Initial project snapshot received.');
    await external.writeFile(file,'module externally_changed; endmodule\n',original.revision);
    let update;for await(const event of observer)if(event.snapshot.entries[0]?.revision!==original.revision){update=event;break;}
    assert(update.snapshot.revision!==page.snapshotRevision,'External change detected; the previous query needs refreshing.');
    const refreshed=await project.searchText(query);assert(refreshed.items[0].entry.revision===update.snapshot.entries[0].revision,'Repeated the same query scope and removed the stale result.');
    assert(edit.snapshot===original&&draft.value.includes('unsaved browser draft'),'Edit snapshot and unsaved browser draft stayed intact.');
    let conflict=false;try{await edit.save(draft.value);}catch(error){if(error.code!=='conflict')throw error;conflict=true;}assert(conflict,'Compare-and-swap rejected the stale save.');
    project.dispose();client.disconnect();await client.connect();project=createWorkspaceProject(client);observer=project.watchProject({root:'rtl',include:query.include},{timeoutMs:30000});assert((await observer.next()).value.cursor===1,'Reconnect starts a new subscription and full initial snapshot.');
    await observer.return();status.textContent='Passed';document.body.dataset.result='passed';
  }catch(error){status.textContent='Failed';log.textContent+='ERROR: '+error.message+'\n';document.body.dataset.result='failed';}
  finally{await observer?.return();project?.dispose();client?.dispose();external?.dispose();button.disabled=false;}
});
