import {verifyPluginBundle} from './bundles.mjs';
import {inspectPluginArchiveBytes} from './publishing.mjs';
import {verifyPluginProvenance} from './provenance.mjs';
import {base64,canonical,clone,digest,fail,fields,sha,string} from './release-internals.mjs';

const hash=value=>digest(canonical(value,1024*1024));
function snapshot(artifact){
  fields(artifact,['bundle','envelope']);
  if(!(artifact.bundle instanceof Uint8Array))fail('INVALID','Expected bundle bytes');
  return {bundle:Uint8Array.from(artifact.bundle),envelope:artifact.envelope===null?null:clone(artifact.envelope)};
}
function describe(artifact,settings){
  const receipt=verifyPluginBundle(artifact.bundle);
  const value=JSON.parse(Buffer.from(artifact.bundle).toString('utf8'));
  const inspected=inspectPluginArchiveBytes(base64(value.plugin.archive,12*1024*1024),value.plugin.metadata,{expectedSha256:value.plugin.sha256});
  const manifest=inspected.manifest;
  const disclosure=JSON.parse(Buffer.from(inspected.files.find(f=>f.path==='disclosure.json').data).toString('utf8'));
  return {schemaVersion:1,bundleSha256:receipt.sha256,name:`@${manifest.publisher}/${manifest.id}`,publisher:manifest.publisher,pluginId:manifest.id,version:manifest.version,api:{protocolVersion:manifest.protocolVersion,capabilities:[...manifest.capabilities].sort(),runtime:manifest.runtime??'ui',supportedHosts:manifest.supportedHosts??[]},grants:[...manifest.permissions].sort(),dependencies:receipt.dependencies.map(p=>({name:p.name,version:p.version,sha256:p.sha256,source:p.source})),tools:disclosure.backends,licenses:[{name:`@${manifest.publisher}/${manifest.id}`,license:manifest.license},...receipt.dependencies.map(p=>({name:p.name,license:p.license,licenseFile:p.licenseFile,noticeFile:p.noticeFile}))],settingsSha256:hash(settings),provenanceSha256:hash(artifact.envelope),keyId:artifact.envelope?.keyId??null};
}
function planBody(current,candidate,migration,jobPolicy){
  for(const value of [current,candidate]){
    fields(value,['schemaVersion','bundleSha256','name','publisher','pluginId','version','api','grants','dependencies','tools','licenses','settingsSha256','provenanceSha256','keyId']);
    if(value.schemaVersion!==1)fail('UNSUPPORTED','Unsupported update descriptor');
    for(const key of ['bundleSha256','settingsSha256','provenanceSha256'])sha(value[key]);
    for(const key of ['name','publisher','pluginId','version'])string(value[key],key,256);
    if(value.keyId!==null)string(value.keyId,'key ID',128);
    for(const key of ['grants','dependencies','tools','licenses'])if(!Array.isArray(value[key])||value[key].length>64)fail('LIMIT','Invalid update descriptor list');
    fields(value.api,['protocolVersion','capabilities','runtime','supportedHosts']);
    if(value.api.protocolVersion!==1||!Array.isArray(value.api.capabilities)||value.api.capabilities.length>64||!Array.isArray(value.api.supportedHosts)||value.api.supportedHosts.length>8)fail('INVALID','Invalid update API descriptor');
    for(const grant of value.grants)string(grant,'grant',128);
  }
  fields(migration,['id','reversible']);string(migration.id,'migration ID',128);if(typeof migration.reversible!=='boolean')fail('INVALID','Migration reversibility required');
  if(!['wait','retain-old'].includes(jobPolicy))fail('INVALID','Select wait or retain-old job policy');
  if(current.name!==candidate.name)fail('CONFLICT','Updates must preserve publisher and plugin identity');
  const changes=Object.fromEntries(['version','api','grants','dependencies','tools','licenses','settingsSha256','provenanceSha256','keyId'].map(key=>[key,canonical(current[key])!==canonical(candidate[key])]));
  return {schemaVersion:1,current,candidate,migration:clone(migration),jobPolicy,changes,externalEffectsUndone:false};
}
/** Pure byte-bound review plan; provenance acceptance is refreshed by the controller. */
export function createPluginUpdatePlan(input){
  fields(input,['current','candidate','settings','nextSettings','migration','jobPolicy']);
  const current=snapshot(input.current),candidate=snapshot(input.candidate);
  const body=planBody(describe(current,input.settings),describe(candidate,input.nextSettings),input.migration,input.jobPolicy);
  return {...body,sha256:hash(body)};
}
export function parsePluginUpdatePlan(value){
  fields(value,['schemaVersion','current','candidate','migration','jobPolicy','changes','externalEffectsUndone','sha256']);
  const body=planBody(value.current,value.candidate,value.migration,value.jobPolicy);
  if(value.schemaVersion!==1||value.externalEffectsUndone!==false||hash(body)!==sha(value.sha256)||canonical(body.changes)!==canonical(value.changes))fail('INTEGRITY','Update plan digest mismatch');
  return clone(value);
}
export function createMemoryUpdateJournal(){
  let value=null;
  return {async read(){return value===null?null:clone(value);},async compareAndSwap(expected,next){if((value?.revision??0)!==expected)fail('CONFLICT','Journal revision changed');if(next.revision!==expected+1)fail('INVALID','Invalid next revision');canonical(next,1024*1024);value=clone(next);return clone(value);}};
}
/** Explicit host readback after a crash. No candidate code, settings migration or job is replayed. */
export async function reconcilePluginUpdateJournal(journal,input){
  fields(input,['expectedRevision','activeSha256','settingsSha256','approved']);
  if(input.approved!==true)fail('APPROVAL_REQUIRED','Explicit host readback approval required');
  const record=await journal.read();
  if(!record||record.revision!==input.expectedRevision)fail('CONFLICT','Journal revision changed');
  const allowed=[{sha256:record.activeSha256,settingsSha256:record.settingsSha256},...(record.plan?[{sha256:record.plan.current.bundleSha256,settingsSha256:record.plan.current.settingsSha256},{sha256:record.plan.candidate.bundleSha256,settingsSha256:record.plan.candidate.settingsSha256}]:[])];
  if(!allowed.some(x=>x.sha256===sha(input.activeSha256)&&x.settingsSha256===sha(input.settingsSha256)))fail('CONFLICT','Host readback does not match a recorded state');
  return journal.compareAndSwap(record.revision,{...record,revision:record.revision+1,activeSha256:input.activeSha256,settingsSha256:input.settingsSha256,phase:'idle',plan:null,disposition:'operator-reconciled'});
}
/** One owning controller per journal. prepare/execute/dispose ports belong to the host operator. */
export async function createPluginUpdateController(options){
  fields(options,['initial','initialHost','settings','getPolicy','prepare','journal']);
  if(typeof options.getPolicy!=='function'||typeof options.prepare!=='function'||typeof options.initialHost?.execute!=='function'||typeof options.initialHost?.dispose!=='function'||typeof options.journal?.read!=='function'||typeof options.journal?.compareAndSwap!=='function')fail('INVALID','Host and journal ports required');
  let current={artifact:snapshot(options.initial),host:options.initialHost,settings:clone(options.settings),jobs:0,retired:false};
  let description=describe(current.artifact,current.settings), pending=null,busy=false,disposed=false,uncertain=false;
  let record=await options.journal.read();const retired=new Set();
  const verifyArtifact=async(artifact,desc)=>{
    const policy=await options.getPolicy(clone(desc),artifact.envelope===null?null:clone(artifact.envelope));
    if(policy.publisher!==desc.publisher||canonical(policy.subject)!==canonical({name:desc.name,version:desc.version,sha256:desc.bundleSha256}))fail('CONFLICT','Policy must bind the exact bundle identity');
    const receipt=verifyPluginProvenance(artifact.bundle,artifact.envelope,policy);
    if(receipt.policy!=='accepted')fail('PROVENANCE_REJECTED',receipt.reasons.join(', '));
    return receipt;
  };
  await verifyArtifact(current.artifact,description);
  if(record){
    if(record.schemaVersion!==1||record.activeSha256!==description.bundleSha256||record.settingsSha256!==description.settingsSha256||!['idle','activated','failed'].includes(record.phase))fail('RECOVERY_REQUIRED','Read back the active host and reconcile its journal explicitly');
  }else record=await options.journal.compareAndSwap(0,{schemaVersion:1,revision:1,activeSha256:description.bundleSha256,settingsSha256:description.settingsSha256,phase:'idle',plan:null,disposition:'initialized'});
  const save=async(patch)=>{
    try{const next={...record,...patch,revision:record.revision+1};record=await options.journal.compareAndSwap(record.revision,next);}
    catch(error){uncertain=true;throw Object.assign(new Error('Journal write outcome requires explicit readback'),{code:'RECOVERY_REQUIRED',cause:error});}
  };
  const enter=()=>{if(disposed)fail('DISPOSED','Update controller disposed');if(uncertain)fail('RECOVERY_REQUIRED','Journal requires readback');if(busy)fail('BUSY','Another update operation is running');busy=true;};
  const cleanup=async(item)=>{if(item.retired&&item.jobs===0){await item.host.dispose();retired.delete(item);}};
  return {
    inspect(){return {record:clone(record),current:clone(description),pending:pending?{plan:clone(pending.plan),approved:pending.approved}:null,jobs:current.jobs,retired:[...retired].map(x=>({sha256:describe(x.artifact,x.settings).bundleSha256,jobs:x.jobs})),disposed,uncertain};},
    async stage(input){
      enter();try{
        fields(input,['candidate','nextSettings','migration','jobPolicy']);
        if(pending)fail('CONFLICT','Discard the current staged plan before staging another');
        const artifact=snapshot(input.candidate),settings=clone(input.nextSettings);
        const plan=createPluginUpdatePlan({current:current.artifact,candidate:artifact,settings:current.settings,nextSettings:settings,migration:input.migration,jobPolicy:input.jobPolicy});
        await verifyArtifact(artifact,plan.candidate);
        await save({phase:'staged',plan,disposition:'review-required'});
        pending={artifact,settings,plan,approved:false};return clone(plan);
      }finally{busy=false;}
    },
    async approve(input){
      enter();try{
        fields(input,['sha256','grants','keyId','approved']);
        if(!pending||input.approved!==true||input.sha256!==pending.plan.sha256||input.keyId!==pending.plan.candidate.keyId||canonical(input.grants)!==canonical(pending.plan.candidate.grants))fail('APPROVAL_REQUIRED','Approval must match the reviewed plan, grants and key');
        await verifyArtifact(pending.artifact,pending.plan.candidate);
        await save({phase:'approved',disposition:'explicitly-approved'});pending.approved=true;return clone(record);
      }finally{busy=false;}
    },
    async activate(input){
      enter();let prepared=null;
      try{
        fields(input,['sha256'],['signal']);
        if(!pending?.approved||input.sha256!==pending.plan.sha256)fail('APPROVAL_REQUIRED','Approve this exact plan before activation');
        if(input.signal?.aborted)fail('CANCELLED','Activation cancelled');
        if(pending.plan.current.bundleSha256!==description.bundleSha256||pending.plan.current.settingsSha256!==hash(current.settings))fail('CONFLICT','Active bytes or settings changed');
        if(pending.plan.jobPolicy==='wait'&&current.jobs)fail('ACTIVE_JOBS','Wait for the current jobs to settle');
        await verifyArtifact(pending.artifact,pending.plan.candidate);
        await save({phase:'preparing',disposition:'activation-pending'});
        try{
          prepared=await options.prepare(Uint8Array.from(pending.artifact.bundle),{settings:clone(pending.settings),grants:[...pending.plan.candidate.grants],signal:input.signal});
          if(typeof prepared?.execute!=='function'||typeof prepared?.dispose!=='function')fail('INVALID','prepare must return a host');
          if(input.signal?.aborted)fail('CANCELLED','Activation cancelled');
          await verifyArtifact(pending.artifact,pending.plan.candidate);
        }catch(error){
          await prepared?.dispose?.();prepared=null;
          await save({phase:'failed',disposition:'prepare-failed'});pending=null;throw error;
        }
        const old=current,next=pending;
        await save({phase:'activated',activeSha256:next.plan.candidate.bundleSha256,settingsSha256:next.plan.candidate.settingsSha256,disposition:'activated'});
        current={artifact:next.artifact,host:prepared,settings:next.settings,jobs:0,retired:false};prepared=null;description=next.plan.candidate;pending=null;
        old.retired=true;retired.add(old);
        let cleanupFailed=false;try{await cleanup(old);}catch{cleanupFailed=true;}
        return {...clone(record),cleanupFailed,externalEffectsUndone:false};
      }finally{try{if(prepared)await prepared.dispose();}finally{busy=false;}}
    },
    async execute(input,{signal}={}){
      if(disposed)fail('DISPOSED','Update controller disposed');if(uncertain)fail('RECOVERY_REQUIRED','Journal requires readback');
      if(busy&&pending?.plan.jobPolicy==='wait')fail('BUSY','Activation is waiting to switch');
      if(signal?.aborted)fail('CANCELLED','Execution cancelled');
      const item=current,pluginSha256=description.bundleSha256;item.jobs++;
      try{return {pluginSha256,result:await item.host.execute(input,{settings:clone(item.settings),signal,pluginSha256})};}
      finally{item.jobs--;try{await cleanup(item);}catch{/* Readback still identifies completed jobs; disposal errors must not replace their results. */}}
    },
    async replaceSettings(expectedSha256,nextSettings){
      enter();try{if(sha(expectedSha256)!==description.settingsSha256)fail('CONFLICT','Settings revision changed');const next=clone(nextSettings),nextHash=hash(next);await save({settingsSha256:nextHash,phase:'idle',plan:null,disposition:'settings-changed'});current.settings=next;description={...description,settingsSha256:nextHash};pending=null;return nextHash;}finally{busy=false;}
    },
    async discard(){enter();try{await save({phase:'idle',plan:null,disposition:'discarded'});pending=null;}finally{busy=false;}},
    async dispose(){
      if(disposed)return;if(busy)fail('BUSY','Update operation still running');if(current.jobs||[...retired].some(x=>x.jobs))fail('ACTIVE_JOBS','Wait for jobs; disposal never cancels them implicitly');
      disposed=true;await current.host.dispose();for(const item of retired)await item.host.dispose();retired.clear();
    },
  };
}
