import {definePlugin,createLanguageResult} from './index.mjs';
import {createTestClock,createMemoryJobStore,flushTestMicrotasks} from './testing.mjs';
import {editHash} from './workspace-edit-contracts.mjs';

export const fixtureManifest = Object.freeze({manifestVersion:2,id:'conformance-plugin',name:'Conformance fixture',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:[],supportedHosts:['test-host','workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}});
export const fixtureDocument = Object.freeze({uri:'memory:///fixture.txt',languageId:'plaintext',modelVersion:1,workspaceRevision:'one',text:'alpha 😀\r\nalpha'});
export function fixturePlugin(activate,changes={}) {return definePlugin({...fixtureManifest,...changes},activate);}
export const fixtureScope = Object.freeze({projectId:'fixture-project',sessionId:'fixture-session'});
export const commandDefinition = Object.freeze({id:'run',title:'Run',inputSchema:{schemaVersion:1,schema:{type:'object',properties:{count:{type:'integer',minimum:1,maximum:5}},required:['count'],additionalProperties:false}},outputSchema:{schemaVersion:1,schema:{type:'object',properties:{total:{type:'integer'}},required:['total'],additionalProperties:false}}});
export const fixtureSettings = Object.freeze({schemaVersion:1,pluginId:fixtureManifest.id,version:1,settings:{count:{schema:{schemaVersion:1,schema:{type:'integer',default:2,minimum:1,maximum:5}},scopes:['user','workspace']}}});

export function verify(value,check) {if(!value){const error=new Error('Conformance assertion failed');error.check=check;throw error;}}
export async function rejected(operation,codes,check) {
  try {await operation();} catch(error) {verify(codes.includes(error?.code),check);return;}
  verify(false,check);
}
export function gate() {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
export async function openHost(ctx,options={}) {
  const host=await ctx.adapters.host({hostId:'workspace-host',scope:fixtureScope,...options});
  ctx.own(()=>host.dispose());return host;
}
async function settleJob(host,id) {
  for(let i=0;i<128;i++){await new Promise(resolve=>setTimeout(resolve,1));const result=host.getJob(id);if(result.state!=='running'&&result.state!=='queued')return result;}
  verify(false,'job_settlement');
}
async function commandFixture(host,handler=()=>({total:2}),changes={}) {
  await host.activate(fixturePlugin(ctx=>ctx.registerCommand(commandDefinition,handler),changes));
}
export const HOST_CASES = {
  async commands(ctx) {
    const host=await openHost(ctx);let calls=0;
    await commandFixture(host,()=>{calls++;return {total:2};});
    const result=await host.executeCommand(fixtureManifest.id,'run',{count:2});
    verify(result.total===2&&calls===1,'valid_command');
    await rejected(()=>host.executeCommand(fixtureManifest.id,'run',{count:0}),['invalid_contract'],'invalid_input');
    verify(calls===1,'invalid_input_no_execution');
    host.deactivate(fixtureManifest.id);
    await commandFixture(host,()=>({total:'wrong'}));
    await rejected(()=>host.executeCommand(fixtureManifest.id,'run',{count:2}),['invalid_contract','provider_failed'],'invalid_output');
    host.deactivate(fixtureManifest.id);
    // Do not use definePlugin here: the adapter's own activation boundary is tested.
    await rejected(()=>host.activate({manifest:{...fixtureManifest,capabilities:['future-unknown']},activate(){calls++;}}),['invalid_contract','version_mismatch'],'unknown_capability');
    verify(calls===1,'unknown_no_execution');
  },
  async permissions(ctx) {
    let reads=0;
    const host=await openHost(ctx,{workspace:{readFile(){reads++;return {path:'fixture.txt',content:'synthetic',revision:'one'};}}});
    const plugin=fixturePlugin(c=>c.registerCommand({id:'read',title:'Read'},()=>c.workspace.readFile('fixture.txt')),{permissions:['workspace.read']});
    await host.activate(plugin);
    await rejected(()=>host.executeCommand(fixtureManifest.id,'read',{}),['permission_denied'],'missing_grant');
    verify(reads===0,'missing_grant_no_port_call');
    const scoped=await openHost(ctx,{grants:['backend.invoke'],backends:{test:(_input,options)=>({scope:options.scope})}});
    await scoped.activate(fixturePlugin(c=>c.registerCommand({id:'scope',title:'Scope'},()=>c.backends.invoke('test',{})),{permissions:['backend.invoke']}));
    const value=await scoped.executeCommand(fixtureManifest.id,'scope',{});
    verify(value.scope?.projectId===fixtureScope.projectId&&value.scope?.sessionId===fixtureScope.sessionId,'operator_scope');
    scoped.replaceGrants([]);
    await rejected(()=>scoped.executeCommand(fixtureManifest.id,'scope',{}),['disposed','permission_denied','capability_unavailable'],'revoked_grant');
  },
  async cancellation(ctx) {
    const host=await openHost(ctx),entered=gate(),finish=gate();let providerSignal;
    ctx.own(()=>finish.resolve({total:1}));
    await commandFixture(host,(_input,{signal})=>{providerSignal=signal;entered.resolve();return finish.promise;});
    const controller=new AbortController();
    const request=host.executeCommand(fixtureManifest.id,'run',{count:1},{signal:controller.signal});
    const outcome=request.then(()=>({code:'unexpected_success'}),error=>({code:error?.code}));
    await entered.promise;controller.abort();
    verify((await outcome).code==='cancelled','caller_cancellation');
    verify(providerSignal.aborted,'provider_cancellation');
    verify(host.inspect().pendingOperations===1,'unsettled_operation_retained');
    finish.resolve({total:1});await flushTestMicrotasks(128);
    verify(host.inspect().pendingOperations===0,'settled_operation_released');
    host.dispose();verify(host.inspect().commands===0&&host.inspect().timers===0,'disposed_resources');
  },
  async language(ctx) {
    const host=await openHost(ctx,{grants:['document.read','language.provide']}),entered=gate(),finish=gate();ctx.own(()=>finish.resolve());
    await host.activate(fixturePlugin(c=>c.registerLanguageProvider('hover',{languages:['plaintext']},{provide:async r=>{entered.resolve();await finish.promise;return createLanguageResult(r,{text:'synthetic hover'});}}),{runtime:'ui',capabilities:['hover'],permissions:['document.read','language.provide']}));
    host.setDocument(fixtureDocument);
    const pending=host.requestLanguage('hover',{position:{line:0,character:1}}).then(()=>({code:'unexpected_success'}),error=>({code:error?.code}));
    await entered.promise;host.setDocument({...fixtureDocument,modelVersion:2});finish.resolve();
    verify(['stale_snapshot','cancelled'].includes((await pending).code),'changed_document_rejected');
    const result=await host.requestLanguage('hover',{position:{line:0,character:1}});
    verify(result.data.text==='synthetic hover'&&result.snapshot.modelVersion===2,'language_identity');
    host.deactivate(fixtureManifest.id);
    await host.activate(fixturePlugin(c=>c.registerLanguageProvider('hover',{languages:['plaintext']},{provide:()=>({data:{text:'unbound'}})}),{runtime:'ui',capabilities:['hover'],permissions:['document.read','language.provide']}));
    await rejected(()=>host.requestLanguage('hover',{position:{line:0,character:1}}),['invalid_contract','provider_failed'],'malformed_provider');
  },
  async 'language-editing'(ctx) {
    const host=await openHost(ctx,{grants:['document.read','language.provide']});
    await host.activate(fixturePlugin(c=>c.registerLanguageProvider('format-document',{languages:['plaintext']},{provide:r=>createLanguageResult(r,{formatVersion:1,id:crypto.randomUUID(),title:'Synthetic formatting',changes:[{kind:'edit',path:r.path,baseRevision:editHash(r.snapshot.text),edits:[{range:{start:{line:0,character:0},end:{line:0,character:5}},text:'beta'}]}]})}),{runtime:'ui',capabilities:['format-document'],permissions:['document.read','language.provide']}));
    host.setDocument(fixtureDocument);const result=await host.requestLanguage('format-document',{path:'fixture.txt',formatOptions:{tabSize:2,insertSpaces:true}});
    const edit=host.prepareFormatting(result);verify(edit.changes[0].edits[0].text==='beta','format_proposal');
    host.setDocument({...fixtureDocument,modelVersion:2});
    await rejected(()=>host.prepareFormatting(result),['stale_snapshot','conflict'],'stale_format_proposal');
  },
  async 'language-display'(ctx) {
    const host=await openHost(ctx,{grants:['document.read','language.provide']});
    await host.activate(fixturePlugin(c=>c.registerLanguageProvider('folding-ranges',{languages:['plaintext']},{provide:r=>createLanguageResult(r,[{range:{start:{line:0,character:0},end:{line:1,character:5}}}])}),{runtime:'ui',capabilities:['folding-ranges'],permissions:['document.read','language.provide']}));
    host.setDocument(fixtureDocument);const result=await host.requestLanguage('folding-ranges',{});
    verify(result.data.length===1&&result.data[0].range.end.line===1,'folding_result');
    host.deactivate(fixtureManifest.id);
    await rejected(()=>host.validateLanguageResult(result),['stale_snapshot','disposed'],'removed_provider_result');
  },
  async settings(ctx) {
    const store=await ctx.adapters.settings(fixtureSettings);ctx.own(()=>store.dispose());
    verify(store.read('first').values.count===2,'default_setting');
    store.update({workspaceId:'first',scope:'user',expectedRevision:0,values:{count:3}});
    store.update({workspaceId:'first',scope:'workspace',expectedRevision:1,values:{count:4}});
    verify(store.read('first').values.count===4&&store.read('second').values.count===3,'scoped_precedence');
    await rejected(()=>store.update({workspaceId:'first',scope:'user',expectedRevision:0,values:{count:5}}),['conflict'],'settings_revision');
    await rejected(()=>store.migrate({...fixtureSettings,version:2},()=>{throw Error('synthetic failure');},{expectedRevision:2}),['provider_failed'],'failed_migration');
    verify(store.read('first').values.count===4&&store.read('first').definitionVersion===1,'migration_rollback');
    const subscription=store.subscribe('first',()=>{});subscription.dispose();verify(store.inspect().subscriptions===0,'subscription_cleanup');
  },
  async jobs(ctx) {
    const host=await openHost(ctx,{jobs:true}),clock=createTestClock();ctx.own(()=>clock.dispose());
    const entered=gate(),finish=gate();ctx.own(()=>finish.resolve({total:2}));
    await commandFixture(host,(_input,{job})=>{job.log('info','Synthetic result');entered.resolve();return finish.promise;});
    const id=clock.runtime.randomUUID();host.startCommandJob(fixtureManifest.id,'run',{count:2},{jobId:id});
    await entered.promise;verify(host.getJobEvents(id).events.length>0,'job_events');
    host.cancelJob(id);verify(host.getJob(id).state==='cancelled','job_cancelled');
    finish.resolve({total:2});await flushTestMicrotasks(128);verify(host.getJob(id).state==='cancelled','late_job_result_ignored');
    verify(host.inspect().pendingJobs===0,'job_slot_cleanup');
    verify(host.startCommandJob(fixtureManifest.id,'run',{count:2},{jobId:id}).state==='cancelled','duplicate_job_idempotent');
    await rejected(()=>host.startCommandJob(fixtureManifest.id,'run',{count:3},{jobId:id}),['conflict'],'changed_job_id_conflict');
  },
  async 'storage-history'(ctx) {
    const clock=createTestClock({seed:42}),store=createMemoryJobStore({identity:{schemaVersion:1,storeId:clock.runtime.randomUUID(),workspaceId:'fixture-project',workspaceIdentity:'a'.repeat(64)}});ctx.own(()=>store.dispose());ctx.own(()=>clock.dispose());
    const options={jobs:true,grants:['workspace.read'],scope:{projectId:store.identity.workspaceId,sessionId:'first'},jobStorage:{store,workspaceIdentity:store.identity.workspaceIdentity,pluginArtifacts:{[fixtureManifest.id]:'a'.repeat(64)}}};
    const first=await openHost(ctx,options);await commandFixture(first,undefined,{permissions:['workspace.read']});
    const id=clock.runtime.randomUUID();first.startCommandJob(fixtureManifest.id,'run',{count:2},{jobId:id});
    verify((await settleJob(first,id)).state==='succeeded','stored_job_succeeded');await first.flushJobStore();first.dispose();
    const second=await openHost(ctx,{...options,scope:{...options.scope,sessionId:'second'}});await commandFixture(second,undefined,{permissions:['workspace.read']});
    const recovered=second.recoverJob(fixtureManifest.id,id);verify(recovered.disposition==='completed','recovered_completed');
    verify(second.listJobHistory(fixtureManifest.id).items.some(item=>item.jobId===id),'history_membership');
    verify(second.inspect().pendingJobs===0,'no_automatic_reexecution');
    second.deactivate(fixtureManifest.id);
    await rejected(()=>second.recoverJob(fixtureManifest.id,id),['disposed','permission_denied','capability_unavailable'],'recovery_current_authority');
  },
};
