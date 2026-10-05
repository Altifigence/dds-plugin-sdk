import {createPluginBundle,lockBundleDependency,verifyPluginBundle,installPluginBundle,type PluginBundleInput,type BundleReceipt} from '@altifigence/dds-plugin-sdk/bundles';
import {createProvenanceStatement,signPluginProvenance,verifyPluginProvenance,type ProvenancePolicy,type ProvenanceKey,type ProvenanceEnvelope} from '@altifigence/dds-plugin-sdk/provenance';
import {createPluginUpdatePlan,createPluginUpdateController,createMemoryUpdateJournal,parsePluginUpdatePlan,type UpdateArtifact,type PluginUpdatePlan} from '@altifigence/dds-plugin-sdk/updates';
import {createNodeUpdateJournal,inspectNodeUpdateJournal} from '@altifigence/dds-plugin-sdk/updates-node';
import {fetchUpstreamArtifact,createUpstreamManifest,inspectUpstreamManifest,createUpstreamCandidate,type UpstreamSource} from '@altifigence/dds-plugin-sdk/upstream';
declare const bytes:Uint8Array,input:PluginBundleInput,key:ProvenanceKey,policy:ProvenancePolicy,artifact:UpdateArtifact;
const bundle:Uint8Array=createPluginBundle(input),receipt:BundleReceipt=verifyPluginBundle(bundle);
await installPluginBundle(bundle,{destination:'/operator/new',expectedSha256:receipt.sha256,approved:true});
lockBundleDependency({name:'example',version:'1.0.0',source:'https://example.com/source',entry:'index.mjs',type:'module',dependencies:{},license:'MIT',licenseFile:'LICENSE',noticeFile:null,redistributable:true,files:[]});
const statement=createProvenanceStatement({subject:policy.subject,publisher:'example',source:{url:'https://example.com/source',revision:'one'},issuedAt:1,expiresAt:2});
const envelope:ProvenanceEnvelope=signPluginProvenance(statement,{keyId:'operator',privateKey:key});verifyPluginProvenance(bytes,envelope,policy).policy;
const plan:PluginUpdatePlan=createPluginUpdatePlan({current:artifact,candidate:artifact,settings:{},nextSettings:{},migration:{id:'one',reversible:true},jobPolicy:'wait'});parsePluginUpdatePlan(plan);
const controller=await createPluginUpdateController({initial:artifact,initialHost:{execute:()=>null,dispose(){}},settings:{},getPolicy:()=>policy,prepare:()=>({execute:()=>null,dispose(){}}),journal:createMemoryUpdateJournal()});
await controller.approve({sha256:plan.sha256,grants:plan.candidate.grants,keyId:plan.candidate.keyId,approved:true});await controller.activate({sha256:plan.sha256});
const nodeJournal=await createNodeUpdateJournal({directory:'/operator/state',workspaceRoot:'/workspace'});await nodeJournal.close();await inspectNodeUpdateJournal({directory:'/operator/state'});
declare const source:UpstreamSource;
await fetchUpstreamArtifact({source,allowedUrls:[source.url],enabled:true,offline:true,maxBytes:4096,timeoutMs:500});
createUpstreamManifest({name:'example',version:'1.0.0',revision:'r1',api:['run'],license:{name:'MIT',text:'license',notice:'',redistributable:true},files:[]});
const snapshot=inspectUpstreamManifest(bytes,source,1);await createUpstreamCandidate({current:snapshot,candidate:snapshot,support:{versions:['1.0.0'],requiredApi:['run']},check:()=>({passed:true,detail:'fixture'})});
// @ts-expect-error installation must carry an explicit true approval
installPluginBundle(bundle,{destination:'/operator/new',expectedSha256:receipt.sha256,approved:false});
// @ts-expect-error jobs cannot be implicitly cancelled by an update
createPluginUpdatePlan({current:artifact,candidate:artifact,settings:{},nextSettings:{},migration:{id:'one',reversible:true},jobPolicy:'cancel-all'});
// @ts-expect-error trust results never authorize execution
const allowed:true=verifyPluginProvenance(bytes,envelope,policy).executionAuthorized;
