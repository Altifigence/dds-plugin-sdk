import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createPluginHost,definePlugin,createLanguageResult} from '@altifigence/dds-plugin-sdk';
import {createConformanceWorkspace} from '@altifigence/dds-plugin-sdk/conformance-node';
import {createSettingsStore} from '@altifigence/dds-plugin-sdk/settings';
import {createDiagnosticSession,profileHost} from '@altifigence/dds-plugin-sdk/diagnostics';
import {createTransferQueue} from '@altifigence/dds-plugin-sdk/transfer-queue';
import {createIncrementalSha256} from '@altifigence/dds-plugin-sdk/artifact-transfer';
import {previewWorkspaceEdit,applyWorkspaceEdit} from '@altifigence/dds-plugin-sdk/workspace-edits';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const digest=value=>createIncrementalSha256().update(value).digest();
function resources(){const result={};for(const name of process.getActiveResourcesInfo())result[name]=(result[name]??0)+1;return result;}
function excess(before,after){return Object.fromEntries(Object.entries(after).filter(([key,count])=>count>(before[key]??0)).map(([key,count])=>[key,count-(before[key]??0)]));}
function sink(){let output=new Uint8Array(),committed=false;return {bytes:()=>output,capabilities:{kind:'caller',seek:false,readback:true,persistence:'on-commit',abort:'discard'},async open(){return {
  async write({offset,bytes}){assert.equal(offset,output.length);const next=new Uint8Array(output.length+bytes.length);next.set(output);next.set(bytes,output.length);output=next;},
  async readback(){return {byteLength:output.length,async read(offset,length){return output.slice(offset,offset+length);}};},
  async commit(){committed=true;},async abort(){if(!committed)output=new Uint8Array();},
};}};}
const manifest={manifestVersion:2,id:'combined-plugin',name:'Combined fixture',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands','settings','hover'],permissions:['settings.read','document.read','language.provide'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const definition={schemaVersion:1,pluginId:manifest.id,version:1,settings:{count:{schema:{schemaVersion:1,schema:{type:'integer',default:2,minimum:1,maximum:5}},scopes:['user','workspace']}}};

/** Independent SDK consumer: real loopback/network/disk plus simultaneous in-process language/settings. */
export async function runCombinedWorkload({cycles=3,faults=false}={}){
  assert.ok(Number.isInteger(cycles)&&cycles>=1&&cycles<=100);assert.equal(typeof faults,'boolean');
  await tick();const beforeResources=resources(),start=performance.now(),cpu=process.cpuUsage(),memory=process.memoryUsage();
  let peakRss=memory.rss,peakHeap=memory.heapUsed,requestBytes=0,responseBytes=0,requests=0,fixtureWriteBytes=0,languageRequests=0,commands=0,observedChanges=0,verifiedTransfers=0;
  const watchLatencyMs=[],hostStartMs=[],faultChecks=[];
  const sampler=setInterval(()=>{const m=process.memoryUsage();peakRss=Math.max(peakRss,m.rss);peakHeap=Math.max(peakHeap,m.heapUsed);},5);
  try{
    for(let cycle=0;cycle<cycles;cycle++){
      let fixture,observer;const queue=createTransferQueue({concurrency:2}),store=createSettingsStore(definition),diagnostics=createDiagnosticSession({enabled:true,capacity:16});
      const host=profileHost(createPluginHost({hostId:'workspace-host',scope:{projectId:'fixture-project',sessionId:'fixture-session'},grants:manifest.permissions,settings:{[manifest.id]:store}}),diagnostics);
      try{
        const began=performance.now();fixture=await createConformanceWorkspace();hostStartMs.push(performance.now()-began);
        await host.activate(definePlugin(manifest,c=>{
          const command=c.registerCommand({id:'read',title:'Read settings'},async()=>({count:(await c.settings.read()).values.count}));
          const language=c.registerLanguageProvider('hover',{languages:['plaintext']},{provide:r=>createLanguageResult(r,{text:'Synthetic hover'})});
          return {dispose(){command.dispose();language.dispose();}};
        }));
        host.setDocument({uri:'memory:///fixture.txt',languageId:'plaintext',modelVersion:1,workspaceRevision:'one',text:'alpha 😀\r\nalpha'});
        observer=fixture.client.watchProject({root:'',intervalMs:250,debounceMs:20},{timeoutMs:5000});const initial=(await observer.next()).value.snapshot;
        const bytes=Uint8Array.from({length:131089},(_v,n)=>(n*17+31)&255),source={byteLength:bytes.length,async read(offset,length){return bytes.slice(offset,offset+length);}};
        const upload=queue.enqueueUpload(fixture.client,source,{uploadId:randomUUID(),pluginId:'conformance-plugin',artifactSha256:fixture.artifactSha256,path:'combined.bin',expectedRevision:null});
        const preview=await previewWorkspaceEdit(fixture.client,{formatVersion:1,id:randomUUID(),title:'Independent created file',changes:[{kind:'create',path:'edited.txt',content:'reviewed synthetic edit'}]});
        const jobId=randomUUID();await fixture.client.startCommandJob('conformance-plugin','capture',{},fixture.artifactSha256,{jobId:jobId});
        const changedAt=performance.now();
        const tasks=[
          (async()=>{for(let n=0;n<40;n++){assert.equal((await host.requestLanguage('hover',{position:{line:0,character:1}})).data.text,'Synthetic hover');languageRequests++;assert.ok([2,3].includes((await host.executeCommand(manifest.id,'read',{})).count));commands++;}})(),
          fixture.writeFixture('beta '+cycle),
          applyWorkspaceEdit(fixture.client,preview,{journal:fixture.journal,reviewed:{planId:preview.planId,digest:preview.digest},authorize:()=>true}).then(result=>assert.equal(result.status,'completed')),
          upload.result.then(result=>{assert.equal(result.commitReceipt.revision,digest(bytes));verifiedTransfers++;}),
          fixture.client.waitForJob(jobId,{intervalMs:250,timeoutMs:5000}).then(result=>assert.equal(result.state,'succeeded')),
          (async()=>{for(let n=0;n<20;n++){const event=await observer.next();if(event.value?.snapshot.revision!==initial.revision){watchLatencyMs.push(performance.now()-changedAt);observedChanges++;return;}}assert.fail('No project update');})(),
        ];
        store.update({workspaceId:'fixture-project',scope:'workspace',expectedRevision:0,values:{count:3}});
        const outcomes=await Promise.allSettled(tasks);for(const result of outcomes)if(result.status==='rejected')throw result.reason;
        await observer.return();observer=null;
        const reference=await fixture.client.getJobBinaryArtifact(jobId,'binary'),destination=sink();
        const download=queue.enqueueDownload(fixture.client,reference,{sink:destination}),received=await download.result;
        assert.equal(received.verification,'stored');assert.equal(digest(destination.bytes()),digest(bytes));verifiedTransfers++;
        assert.equal((await fixture.client.searchText({root:'',query:'reviewed synthetic'})).total,1);
        if(faults){
          fixture.failNextRequest('disconnect');await assert.rejects(fixture.client.readFile('fixture.txt'),{code:'transport_failed'});faultChecks.push('network_interruption');
          assert.equal((await fixture.client.readFile('fixture.txt')).content,'beta '+cycle);
          fixture.failNextRequest('malformed');await assert.rejects(fixture.client.readFile('fixture.txt'),{code:'invalid_request'});faultChecks.push('malformed_response');
          const denied=queue.enqueueUpload(fixture.client,source,{uploadId:randomUUID(),pluginId:'conformance-plugin',artifactSha256:fixture.artifactSha256,path:'revoked.bin',expectedRevision:null,onProgress:p=>{if(p.phase==='uploading')fixture.revokeUploads();}});
          await assert.rejects(denied.result,error=>['permission_denied','unsupported'].includes(error.code));faultChecks.push('mid_transfer_revocation');
          assert.equal((await fixture.client.listFiles()).entries.some(file=>file.path==='revoked.bin'),false);
          host.replaceGrants([]);await assert.rejects(host.executeCommand(manifest.id,'read',{}),error=>['disposed','permission_denied'].includes(error.code));faultChecks.push('host_revocation');
        }
        await fixture.restart();
        await assert.rejects(fixture.client.readJobBinaryArtifactChunk(reference,0),{code:'generation_mismatch'});
        const recovered=await fixture.client.recoverJob('conformance-plugin',jobId,fixture.artifactSha256);assert.equal(recovered.disposition,'completed');
        assert.equal((await fixture.client.listJobHistory('conformance-plugin',fixture.artifactSha256)).items.length,1);
        assert.equal(queue.inspect().active,0);assert.equal(queue.inspect().pending,0);assert.ok(queue.inspect().peakChunkBytes<=65536);
        const m=fixture.metrics();requestBytes+=m.requestBytes;responseBytes+=m.responseBytes;requests+=m.requests;fixtureWriteBytes+=m.fixtureWriteBytes;
      }finally{
        await observer?.return();await queue.dispose();host.dispose();store.dispose();await tick();
        const inspection=host.inspect();for(const key of ['plugins','commands','registrations','pendingActivations','pendingOperations','providerOperations','pendingJobs','binaryOperations','pendingCheckpoints','timers'])assert.equal(inspection[key],0,key);
        assert.equal(queue.inspect().pending,0);assert.equal(queue.inspect().active,0);assert.equal(diagnostics.snapshot().pending,0);assert.equal(store.inspect().subscriptions,0);diagnostics.dispose();await fixture?.dispose();
      }
    }
  }finally{clearInterval(sampler);}
  let remaining;
  for(let n=0;n<20;n++){await tick();remaining=excess(beforeResources,resources());if(Object.keys(remaining).length===0)break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.deepEqual(remaining,{},'SDK fixture left an active Node resource');
  const usage=process.cpuUsage(cpu),finish=process.memoryUsage();
  return {schemaVersion:1,node:process.version,platform:process.platform,arch:process.arch,cycles,faults,fixtureBytes:131089,concurrency:{transfers:2,language:1,commands:1,watch:1,jobs:1,edits:1},elapsedMs:performance.now()-start,cpuMs:(usage.user+usage.system)/1000,peakRssBytes:peakRss,peakHeapBytes:peakHeap,heapDeltaBytes:finish.heapUsed-memory.heapUsed,requestBytes,responseBytes,requests,fixtureWriteBytes,languageRequests,commands,observedChanges,verifiedTransfers,watchLatencyMs,hostStartMs,faultChecks,remainingResources:remaining};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await runCombinedWorkload({faults:process.argv.includes('--faults')}),null,2));
