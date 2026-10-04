import {verify,rejected,fixtureManifest} from './conformance-host.mjs';
import {createTransferQueue} from './transfer-queue.mjs';
import {previewWorkspaceEdit,applyWorkspaceEdit} from './workspace-edits.mjs';
import {createIncrementalSha256} from './sha256-stream.mjs';

export const fixtureBytes=()=>Uint8Array.from({length:131089},(_v,n)=>(n*17+31)&255);
const hash=bytes=>createIncrementalSha256().update(bytes).digest();
export async function openWorkspace(ctx) {
  const fixture=await ctx.adapters.workspace({signal:ctx.signal});ctx.own(()=>fixture.dispose());return fixture;
}
export async function runFixtureJob(f) {
  const id=crypto.randomUUID();await f.client.startCommandJob(fixtureManifest.id,'capture',{},f.artifactSha256,{jobId:id});
  const value=await f.client.waitForJob(id,{intervalMs:250,timeoutMs:5000});verify(value.state==='succeeded','fixture_job_succeeded');
  // Completion of the provider and commitment of its persistent checkpoint are distinct.
  for(let n=0;n<100;n++) {const r=await f.client.recoverJob(fixtureManifest.id,id,f.artifactSha256);if(r.record?.settled)return id;await new Promise(resolve=>setTimeout(resolve,5));}
  verify(false,'fixture_checkpoint_settled');
}
export function memorySink() {
  let bytes=new Uint8Array(),committed=false;
  return {bytes:()=>bytes,capabilities:{kind:'caller',seek:false,readback:true,persistence:'on-commit',abort:'discard'},async open(){return {
    async write({offset,bytes:next}){verify(offset===bytes.length,'sequential_sink');const combined=new Uint8Array(bytes.length+next.length);combined.set(bytes);combined.set(next,bytes.length);bytes=combined;},
    async readback(){return {byteLength:bytes.length,async read(offset,length){return bytes.slice(offset,offset+length);}};},
    async commit(){committed=true;},async abort(){if(!committed)bytes=new Uint8Array();},
  };}};
}
export const WORKSPACE_CASES={
  async files(ctx) {
    const f=await openWorkspace(ctx),client=f.client;
    const first=await client.readFile('fixture.txt');verify(first.content==='alpha 😀\r\nalpha','read_fixture');
    verify((await client.readFileIfChanged('fixture.txt',first.revision)).notModified===true,'conditional_read');
    await f.writeFixture('beta');
    await rejected(()=>client.writeFile('fixture.txt','stale',first.revision),['conflict'],'stale_file_write');
    verify((await client.readFile('fixture.txt')).content==='beta','stale_write_preserves_file');
    await rejected(()=>client.readFile('../outside'),['unsafe_path','invalid_request','permission_denied'],'relative_path_boundary');
    await rejected(()=>client.readFile('.env'),['unsafe_path','permission_denied','not_found'],'protected_path');
    const generation=client.binding.workspace.generation;await f.restart();
    verify(f.client.binding.workspace.generation!==generation,'workspace_generation_changed');
  },
  async projects(ctx) {
    const f=await openWorkspace(ctx),client=f.client;
    verify((await client.getProjectCapabilities()).enabled,'project_capability');
    const query=await client.searchText({root:'',query:'alpha'});verify(query.total===2,'bounded_text_query');
    const observer=client.watchProject({root:'',intervalMs:250,debounceMs:20},{timeoutMs:5000});ctx.own(()=>observer.return());
    const before=(await observer.next()).value.snapshot;await f.writeFixture('beta');
    let changed=false;
    for(let n=0;n<20;n++){const next=await observer.next();if(next.done)break;if(next.value.snapshot.revision!==before.revision){changed=true;break;}}
    verify(changed,'observed_external_change');await observer.return();
    verify((await client.searchText({root:'',query:'alpha'})).total===0,'fresh_search_after_change');
    f.revokeProjects();await rejected(()=>client.searchText({root:'',query:'beta'}),['permission_denied','unsupported','capability_unavailable'],'revoked_projects');
  },
  async artifacts(ctx) {
    const f=await openWorkspace(ctx),id=await runFixtureJob(f),pin=f.artifactSha256;
    const old=await f.client.getStoredJobArtifact(fixtureManifest.id,id,'binary',pin);await f.restart();
    await rejected(()=>f.client.readStoredJobArtifactChunk(old,0),['generation_mismatch'],'old_artifact_generation');
    const fresh=await f.client.getStoredJobArtifact(fixtureManifest.id,id,'binary',pin),sink=memorySink(),queue=createTransferQueue();ctx.own(()=>queue.dispose());
    const task=queue.enqueueStoredDownload(f.client,fresh,{sink}),receipt=await task.result;
    verify(receipt.verification==='stored'&&hash(sink.bytes())===hash(fixtureBytes()),'retained_result_integrity');
    verify(queue.inspect().active===0&&queue.inspect().pending===0,'download_queue_settled');
    await rejected(()=>f.client.getStoredJobArtifact(fixtureManifest.id,id,'binary','0'.repeat(64)),['plugin_mismatch'],'artifact_current_pin');
  },
  async 'uploads-transfers'(ctx) {
    const f=await openWorkspace(ctx),bytes=fixtureBytes(),source={byteLength:bytes.length,async read(offset,length){return bytes.slice(offset,offset+length);}},queue=createTransferQueue({concurrency:2});ctx.own(()=>queue.dispose());
    const spec={uploadId:crypto.randomUUID(),pluginId:fixtureManifest.id,artifactSha256:f.artifactSha256,path:'uploaded.bin',expectedRevision:null};
    const task=queue.enqueueUpload(f.client,source,spec),receipt=await task.result;
    verify(receipt.state==='committed'&&receipt.commitReceipt.revision===hash(bytes),'upload_commit_integrity');
    verify(task.snapshot.verified&&queue.inspect().peakChunkBytes<=65536,'upload_bounded_verified');
    f.revokeUploads();
    const denied=queue.enqueueUpload(f.client,source,{...spec,uploadId:crypto.randomUUID(),path:'denied.bin'});
    await rejected(()=>denied.result,['permission_denied','unsupported','capability_unavailable'],'revoked_upload');
    verify(queue.inspect().active===0&&queue.inspect().pending===0,'upload_queue_settled');
  },
  async 'workspace-edits'(ctx) {
    const f=await openWorkspace(ctx),original=await f.client.readFile('fixture.txt'),journal=f.journal;
    const proposal={formatVersion:1,id:crypto.randomUUID(),title:'Synthetic edit',changes:[{kind:'edit',path:'fixture.txt',baseRevision:original.revision,edits:[{range:{start:{line:0,character:0},end:{line:0,character:5}},text:'beta'}]}]};
    const preview=await previewWorkspaceEdit(f.client,proposal);
    await rejected(()=>applyWorkspaceEdit(f.client,preview,{journal,reviewed:{planId:preview.planId,digest:preview.digest},authorize:()=>false}),['permission_denied'],'edit_requires_approval');
    verify((await f.client.readFile('fixture.txt')).revision===original.revision,'denied_edit_preserves_file');
    const receipt=await applyWorkspaceEdit(f.client,preview,{journal,reviewed:{planId:preview.planId,digest:preview.digest},authorize:()=>true});
    verify(receipt.status==='completed'&&(await f.client.readFile('fixture.txt')).content==='beta 😀\r\nalpha','reviewed_edit_applied');
  },
};
