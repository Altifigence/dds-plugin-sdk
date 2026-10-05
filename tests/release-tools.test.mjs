import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,sign} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {createPluginBundle,verifyPluginBundle,installPluginBundle,lockBundleDependency} from '../src/bundles.mjs';
import {canonicalProvenancePayload,createProvenanceStatement,signPluginProvenance,verifyPluginProvenance} from '../src/provenance.mjs';
import {createPluginUpdateController,createMemoryUpdateJournal,parsePluginUpdatePlan,reconcilePluginUpdateJournal} from '../src/updates.mjs';
import {createNodeUpdateJournal,inspectNodeUpdateJournal} from '../src/updates-node.mjs';
import {createUpstreamManifest,inspectUpstreamManifest,fetchUpstreamArtifact,createUpstreamCandidate} from '../src/upstream.mjs';
import {makeExampleBundle,loadExampleHost,sha256} from '../examples/release-tools/fixture.mjs';

async function temp(t){const root=await realpath(await mkdtemp(path.join(tmpdir(),'dds-release-test-')));t.after(async()=>{assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith('dds-release-test-'));await rm(root,{recursive:true});});return root;}
const unsigned=desc=>({subject:{name:desc.name,version:desc.version,sha256:desc.bundleSha256},publisher:desc.publisher,trustRoots:[],now:1000,revocations:{observedAt:1000,revokedKeyIds:[]},maxRevocationAgeMs:100,offline:true,allowUnsigned:true});
const dummyHost=(value=1)=>({execute:async()=>value,dispose:async()=>{}});
const policyFor=(bytes,key)=>({subject:{name:'@example/unit',version:'1.0.0',sha256:sha256(bytes)},publisher:'example',trustRoots:[{keyId:'key-1',publisher:'example',publicKey:key,validFrom:100,validUntil:5000,revokedAt:null}],now:1000,revocations:{observedAt:900,revokedKeyIds:[]},maxRevocationAgeMs:500,offline:true,allowUnsigned:false});

test('bundle lock and bytes are deterministic; offline installation executes a real dependency through SDK host',async t=>{
  const root=await temp(t),fixture=await makeExampleBundle(path.join(root,'source'));
  assert.deepEqual(createPluginBundle(fixture.input),fixture.bundle);
  const receipt=verifyPluginBundle(fixture.bundle,{expectedSha256:sha256(fixture.bundle)});
  assert.equal(receipt.executionAuthorized,false);assert.equal(receipt.sbom.dependencies.length,2);
  assert.equal(receipt.dependencies[0].noticeFile,'NOTICE');
  const host=await loadExampleHost(fixture.bundle,path.join(root,'installed'));
  try{assert.deepEqual(await host.execute({value:4}),{value:9,version:'1.0.0'});}finally{host.dispose();}
  await assert.rejects(installPluginBundle(fixture.bundle,{destination:path.join(root,'installed'),expectedSha256:receipt.sha256,approved:true}),{code:'EEXIST'});
  await assert.rejects(installPluginBundle(fixture.bundle,{destination:path.join(root,'denied'),expectedSha256:receipt.sha256,approved:false}),{code:'APPROVAL_REQUIRED'});
});

test('bundle rejects changed root/dependency/SBOM bytes and invalid lock graphs',async t=>{
  const root=await temp(t),fixture=await makeExampleBundle(path.join(root,'source'));
  const change=(mutate)=>{const input=structuredClone(fixture.input);mutate(input);assert.throws(()=>createPluginBundle(input));};
  change(x=>x.plugin.sha256='0'.repeat(64));
  change(x=>x.packages[0].files[0].data=Buffer.from('changed').toString('base64'));
  change(x=>x.dependencies['dds-example-math']='^1.0.0');
  change(x=>x.dependencies['dds-example-math']='2.0.0');
  change(x=>x.dependencies.missing='1.0.0');
  change(x=>x.packages.push(x.packages[0]));
  change(x=>x.dependencies={});
  change(x=>{const {sha256,...pkg}=x.packages[0];pkg.dependencies={'dds-example-math':'1.0.0'};x.packages[0]=lockBundleDependency(pkg);});
  const value=JSON.parse(Buffer.from(fixture.bundle));value.sbom.version=2;
  assert.throws(()=>verifyPluginBundle(Buffer.from(JSON.stringify(value))));
  assert.throws(()=>verifyPluginBundle(fixture.bundle,{expectedSha256:'0'.repeat(64)}));
});

test('dependency file inventory rejects missing rights, paths, links/scripts metadata and limits',async t=>{
  const root=await temp(t),fixture=await makeExampleBundle(path.join(root,'source'));
  const {sha256,...base}=fixture.input.packages[0];
  for(const file of ['../outside','/absolute','folder\\file','NUL','trailing.','node_modules/hidden.mjs','package.json']){
    assert.throws(()=>lockBundleDependency({...base,files:[...base.files,{path:file,data:'eA=='}]}));
  }
  assert.throws(()=>lockBundleDependency({...base,files:base.files.filter(x=>x.path!=='LICENSE')}));
  assert.throws(()=>lockBundleDependency({...base,redistributable:false}));
  assert.throws(()=>lockBundleDependency({...base,scripts:{install:'unsupported'}}));
  assert.throws(()=>lockBundleDependency({...base,files:[...base.files,{path:'linked',data:'eA==',type:'symlink'}]}));
  assert.throws(()=>lockBundleDependency({...base,files:new Array(1025).fill(base.files[0])}));
  assert.throws(()=>lockBundleDependency({...base,files:[...base.files,{path:'folder',data:'eA=='},{path:'folder/a',data:'eA=='}]}));
  assert.throws(()=>lockBundleDependency({...base,files:[...base.files,{path:'license',data:'eA=='}]}));
});

test('independently signed literal payload verifies, while wrong bytes/key/subject/publisher/algorithm do not',()=>{
  const bytes=Buffer.from('public fixture'),pair=generateKeyPairSync('ed25519'),other=generateKeyPairSync('ed25519');
  const policy=policyFor(bytes,pair.publicKey);
  const payload=createProvenanceStatement({subject:policy.subject,publisher:'example',source:{url:'https://example.com/source',revision:'abc'},issuedAt:500,expiresAt:2000});
  const literal='DDS-PROVENANCE-V1\n'+`{"expiresAt":2000,"issuedAt":500,"publisher":"example","schemaVersion":1,"source":{"revision":"abc","url":"https://example.com/source"},"subject":{"name":"@example/unit","sha256":"${sha256(bytes)}","version":"1.0.0"}}`;
  assert.equal(Buffer.from(canonicalProvenancePayload(payload)).toString(),literal);
  const envelope={schemaVersion:1,algorithm:'Ed25519',keyId:'key-1',payload,signature:sign(null,Buffer.from(literal),pair.privateKey).toString('base64')};
  assert.deepEqual(signPluginProvenance(payload,{keyId:'key-1',privateKey:pair.privateKey}),envelope);
  const receipt=verifyPluginProvenance(bytes,envelope,policy);assert.equal(receipt.policy,'accepted');assert.equal(receipt.executionAuthorized,false);
  assert.equal(verifyPluginProvenance(Buffer.from('changed'),envelope,policy).checksum,false);
  assert.equal(verifyPluginProvenance(bytes,envelope,{...policy,subject:{...policy.subject,name:'@example/other'}}).policy,'rejected');
  assert.equal(verifyPluginProvenance(bytes,envelope,{...policy,publisher:'other'}).policy,'rejected');
  assert.equal(verifyPluginProvenance(bytes,envelope,{...policy,trustRoots:[{...policy.trustRoots[0],publicKey:other.publicKey}]}).signature,'invalid');
  assert.equal(verifyPluginProvenance(bytes,{...envelope,algorithm:'unknown'},policy).signature,'unsupported');
  assert.equal(verifyPluginProvenance(bytes,{...envelope,keyId:'new-package-key'},policy).signature,'untrusted-key');
});

test('signature expiry, revocation freshness, rotation, skew and unsigned compatibility remain explicit',()=>{
  const bytes=Buffer.from('fixture'),pair=generateKeyPairSync('ed25519'),policy=policyFor(bytes,pair.publicKey);
  const payload=createProvenanceStatement({subject:policy.subject,publisher:'example',source:{url:'https://example.com/source',revision:'abc'},issuedAt:500,expiresAt:2000});
  const envelope=signPluginProvenance(payload,{keyId:'key-1',privateKey:pair.privateKey});
  for(const overrides of [{now:2000},{now:400},{revocations:{observedAt:0,revokedKeyIds:[]}},{revocations:{observedAt:900,revokedKeyIds:['key-1']}},{trustRoots:[{...policy.trustRoots[0],revokedAt:900}]},{trustRoots:[{...policy.trustRoots[0],validUntil:900}]}])assert.equal(verifyPluginProvenance(bytes,envelope,{...policy,...overrides}).policy,'rejected');
  assert.equal(verifyPluginProvenance(bytes,envelope,{...policy,now:450,clockSkewMs:100,revocations:{observedAt:400,revokedKeyIds:[]}}).policy,'accepted');
  const rotated=signPluginProvenance(payload,{keyId:'key-2',privateKey:pair.privateKey});
  assert.equal(verifyPluginProvenance(bytes,rotated,{...policy,trustRoots:[...policy.trustRoots,{...policy.trustRoots[0],keyId:'key-2'}]}).policy,'accepted');
  assert.equal(verifyPluginProvenance(bytes,null,policy).policy,'rejected');
  const unsigned=verifyPluginProvenance(bytes,null,{...policy,allowUnsigned:true});assert.equal(unsigned.policy,'accepted');assert.equal(unsigned.publisher,'unverified');assert.equal(unsigned.signature,'unsigned');
});

async function updateFixture(t,overrides={}){
  const root=await temp(t),before=await makeExampleBundle(path.join(root,'before')),after=await makeExampleBundle(path.join(root,'after'),'1.1.0',2);
  const current={bundle:before.bundle,envelope:null},candidate={bundle:after.bundle,envelope:null};
  const journal=createMemoryUpdateJournal();const controller=await createPluginUpdateController({initial:current,initialHost:dummyHost(1),settings:{value:1},getPolicy:unsigned,prepare:()=>dummyHost(2),journal,...overrides});
  t.after(()=>controller.dispose());
  return {root,current,candidate,controller,journal};
}
const stage=async(f,jobPolicy='wait')=>f.controller.stage({candidate:f.candidate,nextSettings:{value:2},migration:{id:'settings-v2',reversible:true},jobPolicy});
const approve=(controller,plan)=>controller.approve({sha256:plan.sha256,grants:plan.candidate.grants,keyId:plan.candidate.keyId,approved:true});

test('plan detects API/grants/dependencies/license/settings/key changes, binds bytes and requires exact approval',async t=>{
  const f=await updateFixture(t),plan=await stage(f);assert.deepEqual(parsePluginUpdatePlan(plan),plan);assert.equal(plan.changes.version,true);assert.equal(plan.changes.settingsSha256,true);assert.equal(plan.changes.grants,false);
  assert.throws(()=>parsePluginUpdatePlan({...plan,changes:{...plan.changes,grants:true}}));
  await assert.rejects(f.controller.activate({sha256:plan.sha256}),{code:'APPROVAL_REQUIRED'});
  await assert.rejects(approve(f.controller,{...plan,sha256:'0'.repeat(64)}),{code:'APPROVAL_REQUIRED'});
  await assert.rejects(f.controller.approve({sha256:plan.sha256,grants:['workspace.read'],keyId:null,approved:true}),{code:'APPROVAL_REQUIRED'});
  await approve(f.controller,plan);await f.controller.activate({sha256:plan.sha256});assert.equal((await f.controller.execute({})).result,2);
  const rollback=await f.controller.stage({candidate:f.current,nextSettings:{value:1},migration:{id:'restore',reversible:true},jobPolicy:'wait'});await approve(f.controller,rollback);assert.equal((await f.controller.activate({sha256:rollback.sha256})).externalEffectsUndone,false);
});

test('settings changes invalidate approval; preparation failure preserves the active host',async t=>{
  const f=await updateFixture(t,{prepare:()=>{throw Error('migration cannot prepare');}});const plan=await stage(f);await approve(f.controller,plan);
  await f.controller.replaceSettings(f.controller.inspect().current.settingsSha256,{value:3});await assert.rejects(f.controller.activate({sha256:plan.sha256}),{code:'APPROVAL_REQUIRED'});
  const retry=await stage(f);await approve(f.controller,retry);await assert.rejects(f.controller.activate({sha256:retry.sha256}),/migration/);assert.equal((await f.controller.execute({})).result,1);assert.equal(f.controller.inspect().record.phase,'failed');
});

test('old execution leases survive retain-old updates; wait and disposal never cancel active jobs',async t=>{
  let finish,oldDisposed=0;const gate=new Promise(resolve=>{finish=resolve;});
  const f=await updateFixture(t,{initialHost:{execute:()=>gate,dispose:()=>{oldDisposed++;}}});
  const running=f.controller.execute({});const blocked=await stage(f);await approve(f.controller,blocked);
  await assert.rejects(f.controller.activate({sha256:blocked.sha256}),{code:'ACTIVE_JOBS'});await assert.rejects(f.controller.dispose(),{code:'ACTIVE_JOBS'});
  await f.controller.discard();const keep=await stage(f,'retain-old');await approve(f.controller,keep);await f.controller.activate({sha256:keep.sha256});assert.equal(oldDisposed,0);
  finish(7);assert.equal((await running).pluginSha256,sha256(f.current.bundle));assert.equal(oldDisposed,1);assert.equal((await f.controller.execute({})).pluginSha256,sha256(f.candidate.bundle));
});

test('activation rechecks current policy and rejects concurrent requests or cancelled preparation',async t=>{
  let denied=false,finish;const gate=new Promise(resolve=>{finish=resolve;});
  const f=await updateFixture(t,{getPolicy:desc=>({...unsigned(desc),allowUnsigned:!denied}),prepare:async()=>{await gate;return dummyHost(2);}});
  const plan=await stage(f);await approve(f.controller,plan);denied=true;await assert.rejects(f.controller.activate({sha256:plan.sha256}),{code:'PROVENANCE_REJECTED'});denied=false;
  const abort=new AbortController(),pending=f.controller.activate({sha256:plan.sha256,signal:abort.signal});
  await assert.rejects(f.controller.activate({sha256:plan.sha256}),{code:'BUSY'});abort.abort();finish();await assert.rejects(pending,{code:'CANCELLED'});assert.equal((await f.controller.execute({})).result,1);
});

test('uncertain journal acknowledgement blocks activation and requires explicit readback',async t=>{
  const journal=createMemoryUpdateJournal();let inject=false;
  const wrapper={read:()=>journal.read(),async compareAndSwap(expected,next){const result=await journal.compareAndSwap(expected,next);if(inject&&next.phase==='activated')throw Error('ack lost');return result;}};
  const f=await updateFixture(t,{journal:wrapper});const plan=await stage(f);await approve(f.controller,plan);inject=true;
  await assert.rejects(f.controller.activate({sha256:plan.sha256}),{code:'RECOVERY_REQUIRED'});assert.equal(f.controller.inspect().uncertain,true);await assert.rejects(f.controller.execute({}),{code:'RECOVERY_REQUIRED'});
  const recorded=await journal.read();assert.equal(recorded.activeSha256,plan.candidate.bundleSha256);
  const reconciled=await reconcilePluginUpdateJournal(journal,{expectedRevision:recorded.revision,activeSha256:plan.current.bundleSha256,settingsSha256:plan.current.settingsSha256,approved:true});assert.equal(reconciled.phase,'idle');
});

test('Node journal persists exact CAS state and prevents multiple writers or workspace placement',async t=>{
  const root=await temp(t),workspace=path.join(root,'workspace');await mkdir(workspace);
  await assert.rejects(createNodeUpdateJournal({directory:path.join(workspace,'state'),workspaceRoot:workspace}),{code:'INVALID'});
  const options={directory:path.join(root,'state'),workspaceRoot:workspace};const journal=await createNodeUpdateJournal(options);
  await assert.rejects(createNodeUpdateJournal(options),{code:'EEXIST'});
  const record={schemaVersion:1,revision:1,activeSha256:'a'.repeat(64),settingsSha256:'b'.repeat(64),phase:'idle',plan:null,disposition:'fixture'};
  await journal.compareAndSwap(0,record);await assert.rejects(journal.compareAndSwap(0,record),{code:'CONFLICT'});await journal.close();
  const reopened=await createNodeUpdateJournal(options);assert.deepEqual(await reopened.read(),record);await reopened.close();
  await writeFile(path.join(options.directory,'000002.json'),'partial');assert.equal((await inspectNodeUpdateJournal({directory:options.directory})).state,'unreadable');
});

test('real child termination leaves a preparing record and never replays candidate activation', {timeout:15000},async t=>{
  const root=await temp(t),workspace=path.join(root,'workspace'),directory=path.join(root,'state');await mkdir(workspace);
  const child=spawn(process.execPath,[new URL('./fixtures/update-crash.mjs',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),directory,workspace],{stdio:['ignore','pipe','pipe']});
  const ready=once(child.stdout,'data');const exited=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill();});await ready;child.kill();await exited;
  const journal=await createNodeUpdateJournal({directory,workspaceRoot:workspace,recoverStaleLock:true});try{const record=await journal.read();assert.equal(record.phase,'preparing');assert.equal(record.disposition,'fixture-before-activation');const next=await reconcilePluginUpdateJournal(journal,{expectedRevision:record.revision,activeSha256:record.activeSha256,settingsSha256:record.settingsSha256,approved:true});assert.equal(next.phase,'idle');}finally{await journal.close();}
});

function upstream(version,api=['run'],license='Apache-2.0'){const value=createUpstreamManifest({name:'example',version,revision:'r'+version,api,license:{name:license,text:'Example license text',notice:'Example NOTICE',redistributable:true},files:[{path:'index.mjs',sha256:sha256(Buffer.from(version))}]});const bytes=Buffer.from(JSON.stringify(value));return {bytes,source:{url:'https://example.com/release',version,sha256:sha256(bytes)}};}

test('upstream comparison distinguishes supported, unsupported, unverified and failed candidates',async()=>{
  const a=upstream('1.0.0'),b=upstream('1.1.0',['run','extra'],'MIT'),current=inspectUpstreamManifest(a.bytes,a.source,100),candidate=inspectUpstreamManifest(b.bytes,b.source,200),support={versions:['1.1.0'],requiredApi:['run']};
  let report=await createUpstreamCandidate({current,candidate,support});assert.equal(report.compatibility,'unverified');assert.equal(report.licenseChanged,true);assert.deepEqual(report.api.added,['extra']);assert.deepEqual(report.files.changed,['index.mjs']);
  report=await createUpstreamCandidate({current,candidate,support,check:()=>({passed:true,detail:'Functional adapter fixture'})});assert.equal(report.compatibility,'supported');assert.equal(report.reviewRequired,true);assert.deepEqual(report.automaticActions,[]);
  assert.equal((await createUpstreamCandidate({current,candidate,support:{...support,requiredApi:['missing']},check:()=>({passed:true,detail:'fixture'})})).compatibility,'unsupported');
  assert.equal((await createUpstreamCandidate({current,candidate,support,check:()=>{throw Error('failed');}})).functional.state,'failed');
  const moved=upstream('1.0.0',['run','moved']);assert.equal((await createUpstreamCandidate({current,candidate:inspectUpstreamManifest(moved.bytes,moved.source,300),support})).tagChanged,true);
  assert.throws(()=>inspectUpstreamManifest(a.bytes,{...a.source,version:'9.0.0'},100));
});

test('explicit upstream fetch enforces byte/time/source/offline budgets and detects tag drift/missing releases',async t=>{
  const artifact=upstream('1.1.0');let hits=0;const server=createServer((req,res)=>{hits++;if(req.url==='/missing'){res.writeHead(404).end();return;}if(req.url==='/slow'){setTimeout(()=>res.end(artifact.bytes),200);return;}if(req.url==='/redirect'){res.writeHead(302,{location:'/outside'}).end();return;}res.end(artifact.bytes);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/release`,options={source:{...artifact.source,url},allowedUrls:[url],enabled:true,offline:false,maxBytes:4096,timeoutMs:1000,allowLoopback:true};
  assert.equal((await fetchUpstreamArtifact(options)).status,'verified');
  const before=hits;assert.equal((await fetchUpstreamArtifact({...options,offline:true})).status,'offline');assert.equal(hits,before);
  assert.equal((await fetchUpstreamArtifact({...options,source:{...options.source,sha256:'0'.repeat(64)}})).status,'digest-mismatch');
  assert.equal((await fetchUpstreamArtifact({...options,maxBytes:4})).reason,'LIMIT');
  for(const [route,expected] of [['missing','http-404'],['slow','timeout'],['redirect','SOURCE_DENIED']]){const target=url.replace('/release','/'+route);assert.equal((await fetchUpstreamArtifact({...options,source:{...options.source,url:target},allowedUrls:[target],timeoutMs:route==='slow'?10:1000})).reason,expected);}
  await assert.rejects(fetchUpstreamArtifact({...options,enabled:false}),{code:'APPROVAL_REQUIRED'});
  await assert.rejects(fetchUpstreamArtifact({...options,allowedUrls:[url+'/other']}),{code:'SOURCE_DENIED'});
  const abort=new AbortController();abort.abort();assert.equal((await fetchUpstreamArtifact({...options,signal:abort.signal})).reason,'cancelled');
});
