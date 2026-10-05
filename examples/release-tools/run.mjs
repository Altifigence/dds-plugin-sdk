import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {verifyPluginBundle,createPluginBundle} from '@altifigence/dds-plugin-sdk/bundles';
import {createProvenanceStatement,signPluginProvenance,verifyPluginProvenance} from '@altifigence/dds-plugin-sdk/provenance';
import {createPluginUpdateController} from '@altifigence/dds-plugin-sdk/updates';
import {createNodeUpdateJournal,inspectNodeUpdateJournal} from '@altifigence/dds-plugin-sdk/updates-node';
import {createUpstreamManifest,inspectUpstreamManifest,fetchUpstreamArtifact,createUpstreamCandidate} from '@altifigence/dds-plugin-sdk/upstream';
import {makeExampleBundle,loadExampleHost,sha256} from './fixture.mjs';

const root=await realpath(await mkdtemp(path.join(tmpdir(),'dds-release-tools-')));let controller,journal,server;
try{
  const old=await makeExampleBundle(path.join(root,'old')),next=await makeExampleBundle(path.join(root,'next'),'1.1.0',2);
  assert.deepEqual(createPluginBundle(old.input),old.bundle);
  const receipt=verifyPluginBundle(next.bundle,{expectedSha256:sha256(next.bundle)});assert.equal(receipt.sbom.specVersion,'1.6');
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),now=Date.now();
  const sign=(bundle,version)=>signPluginProvenance(createProvenanceStatement({subject:{name:'@example/release-tools-example',version,sha256:sha256(bundle)},publisher:'example',source:{url:'https://github.com/Altifigence/dds-plugin-sdk',revision:'sdk-authored-example'},issuedAt:now-1000,expiresAt:now+60000}),{keyId:'ephemeral-example',privateKey});
  const current={bundle:old.bundle,envelope:sign(old.bundle,'1.0.0')},candidate={bundle:next.bundle,envelope:sign(next.bundle,'1.1.0')};
  const policy=(descriptor)=>({subject:{name:descriptor.name,version:descriptor.version,sha256:descriptor.bundleSha256},publisher:'example',trustRoots:[{keyId:'ephemeral-example',publisher:'example',publicKey,validFrom:now-2000,validUntil:now+120000,revokedAt:null}],now:Date.now(),revocations:{observedAt:now,revokedKeyIds:[]},maxRevocationAgeMs:120000,offline:true,allowUnsigned:false});
  const workspace=path.join(root,'workspace');await mkdir(workspace);
  journal=await createNodeUpdateJournal({directory:path.join(root,'journal'),workspaceRoot:workspace});let installs=0;
  controller=await createPluginUpdateController({initial:current,initialHost:await loadExampleHost(current.bundle,path.join(workspace,'initial')),settings:{revision:1},getPolicy:policy,prepare:(bundle,{grants})=>loadExampleHost(bundle,path.join(workspace,'install-'+(++installs)),grants),journal});
  const oldJob=controller.execute({value:5,delay:80});
  const plan=await controller.stage({candidate,nextSettings:{revision:2},migration:{id:'example-settings-v2',reversible:true},jobPolicy:'retain-old'});
  await assert.rejects(controller.activate({sha256:plan.sha256}),{code:'APPROVAL_REQUIRED'});
  await controller.approve({sha256:plan.sha256,grants:plan.candidate.grants,keyId:plan.candidate.keyId,approved:true});
  await controller.activate({sha256:plan.sha256});
  const latest=await controller.execute({value:5});assert.equal(latest.result.value,12);assert.equal(latest.pluginSha256,sha256(next.bundle));
  const first=await oldJob;assert.equal(first.result.value,11);assert.equal(first.pluginSha256,sha256(old.bundle));
  const rollback=await controller.stage({candidate:current,nextSettings:{revision:1},migration:{id:'restore-example-settings',reversible:true},jobPolicy:'wait'});
  await controller.approve({sha256:rollback.sha256,grants:rollback.candidate.grants,keyId:rollback.candidate.keyId,approved:true});
  const restored=await controller.activate({sha256:rollback.sha256});assert.equal(restored.externalEffectsUndone,false);assert.equal((await controller.execute({value:5})).result.value,11);
  await controller.dispose();controller=null;await journal.close();journal=null;
  const readback=await inspectNodeUpdateJournal({directory:path.join(root,'journal')});assert.equal(readback.state,'readable');assert.equal(readback.record.activeSha256,sha256(old.bundle));
  const manifest=version=>createUpstreamManifest({name:'example-upstream',version,revision:'fixture-'+version,api:['twice'],license:{name:'Apache-2.0',text:'SDK-authored fixture under Apache-2.0.',notice:'Example only.',redistributable:true},files:[{path:'index.mjs',sha256:sha256(Buffer.from('example '+version))}]});
  const before=Buffer.from(JSON.stringify(manifest('1.0.0'))),after=Buffer.from(JSON.stringify(manifest('1.1.0')));
  server=createServer((req,res)=>{const bytes=req.url==='/old'?before:after;res.writeHead(200,{'Content-Length':bytes.length});res.end(bytes);});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`,oldSource={url:base+'/old',version:'1.0.0',sha256:sha256(before)},newSource={url:base+'/new',version:'1.1.0',sha256:sha256(after)};
  const fetched=await fetchUpstreamArtifact({source:newSource,allowedUrls:[newSource.url],enabled:true,offline:false,maxBytes:65536,timeoutMs:2000,allowLoopback:true});assert.equal(fetched.status,'verified');
  const update=await createUpstreamCandidate({current:inspectUpstreamManifest(before,oldSource,now),candidate:inspectUpstreamManifest(fetched.artifact,newSource,fetched.observedAt),support:{versions:['1.1.0'],requiredApi:['twice']},check:()=>({passed:true,detail:'Example arithmetic adapter fixture passed'})});assert.equal(update.compatibility,'supported');assert.equal(update.reviewRequired,true);assert.deepEqual(update.automaticActions,[]);
  const signature=verifyPluginProvenance(next.bundle,candidate.envelope,policy(plan.candidate));assert.equal(signature.signature,'verified');assert.equal(signature.executionAuthorized,false);
  console.log(JSON.stringify({version:'1.1.0',deterministicBundle:true,offlineInstall:true,sbom:'CycloneDX 1.6',signed:true,oldJobPinned:true,activated:true,rollback:true,journalReadback:true,upstreamCandidate:true,automaticActions:0}));
}finally{
  if(controller)await controller.dispose();if(journal)await journal.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith('dds-release-tools-'));await rm(root,{recursive:true});
}
