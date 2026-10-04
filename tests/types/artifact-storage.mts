import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import {createNodeJobStore} from '@altifigence/dds-plugin-sdk/job-storage-node';
import {createNodeArtifactStore} from '@altifigence/dds-plugin-sdk/artifact-storage-node';
import {parseStoredArtifactReference,type ArtifactStore,type StoredArtifactReference,type StoredArtifactChunk} from '@altifigence/dds-plugin-sdk/artifact-storage';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {createWorkspaceServer,downloadStoredJobArtifact} from '@altifigence/dds-plugin-sdk/workspace-node';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';
const store=await createNodeJobStore({directory:'/operator/storage',workspaceRoot:'/operator/project',workspaceId:crypto.randomUUID()}),artifacts=await createNodeArtifactStore({jobStore:store,maxBytes:1000000});
const port:ArtifactStore=artifacts;void port;
const host=createPluginHost({jobs:true,jobStorage:{store,artifacts,workspaceIdentity:store.identity.workspaceIdentity,pluginArtifacts:{example:'a'.repeat(64)}}});
void host.artifactStorageCapabilities();void host.listStoredJobArtifacts('example',crypto.randomUUID());
const reference:StoredArtifactReference=await host.getStoredJobArtifact('example',crypto.randomUUID(),'trace');
const chunk:StoredArtifactChunk=await host.readStoredJobArtifactChunk(reference,0,65536);void chunk;void parseStoredArtifactReference(reference);
await createWorkspaceServer({root:'/operator/project',workspaceId:store.identity.workspaceId,token:'a'.repeat(64),notice:{id:'test',version:'1',text:'test'},jobs:true,jobStorage:{store,artifacts}});
const client=createWorkspaceClient({url:'http://127.0.0.1:9000',token:'a'.repeat(64)});
await client.getArtifactStorageCapabilities();await client.listStoredJobArtifacts('example',crypto.randomUUID(),'a'.repeat(64));
await client.getStoredJobArtifact('example',crypto.randomUUID(),'trace','a'.repeat(64));await client.readStoredJobArtifactChunk(reference,0,{length:123});await client.readStoredJobArtifactText(reference);
const receipt=await downloadStoredJobArtifact(client,reference,{destination:'/operator/download.bin',resume:true});const proof:'snapshot'=receipt.storage;void proof;
await artifacts.remove(reference.snapshot);await artifacts.prune({orphans:true});void artifacts.inspect().records;
void SCHEMAS['stored-artifact'];void SCHEMAS['stored-artifact-reference'];void SCHEMAS['stored-artifact-chunk'];void SCHEMAS['stored-artifact-list'];void SCHEMAS['artifact-storage-capabilities'];
// @ts-expect-error snapshot storage requires the concrete owning Node job store
await createNodeArtifactStore({});
// @ts-expect-error a source reference is not a retained snapshot reference
await client.readStoredJobArtifactChunk({jobId:'id',scope:{projectId:'project',sessionId:'session'},artifact:{id:'trace',path:'trace.bin',revision:'a'.repeat(64),byteLength:0}},0);
host.dispose();await host.flushJobStore();await artifacts.close();await store.close();
