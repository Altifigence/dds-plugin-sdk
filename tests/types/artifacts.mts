import {definePlugin,createPluginHost,type PluginManifestV2} from '@altifigence/dds-plugin-sdk';
import {BINARY_ARTIFACT_LIMITS,decodeBinaryArtifactData,parseBinaryArtifactReference,type BinaryArtifactReference,type BinaryArtifactSource} from '@altifigence/dds-plugin-sdk/artifacts';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {createNodeWorkspace,createWorkspaceServer,downloadJobBinaryArtifact} from '@altifigence/dds-plugin-sdk/workspace-node';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';
declare const manifest:PluginManifestV2;
const plugin=definePlugin(manifest,context=>context.registerCommand({id:'collect',title:'Collect'},async(_,{job})=>{
  if(!job)return null;
  const artifact=await job.addBinaryArtifact({id:'trace',path:'trace.bin',label:'Trace'});
  return {bytes:artifact.byteLength};
}));
const client=createWorkspaceClient({url:'https://workspace.example.org',token:'explicit-operator-runtime-value-only'});
declare const reference:BinaryArtifactReference;
void client.getBinaryArtifactCapabilities(); void client.listJobBinaryArtifacts(reference.jobId);
void client.getJobBinaryArtifact(reference.jobId,'trace');
const chunk=await client.readJobBinaryArtifactChunk(reference,0,{length:1024});
const bytes:Uint8Array=decodeBinaryArtifactData(chunk.data); void bytes;
void parseBinaryArtifactReference(reference); void BINARY_ARTIFACT_LIMITS.chunkBytes; void SCHEMAS['binary-artifact-chunk'];
const receipt=await downloadJobBinaryArtifact(client,reference,{destination:'/operator/downloads/trace.bin',resume:true,onProgress:update=>{const verified:false=update.verified;void verified;}});
const verified:true=receipt.verified;void verified;
// @ts-expect-error a destination must be explicitly chosen by the caller
void downloadJobBinaryArtifact(client,reference,{});
// @ts-expect-error a saved artifact reference, including its scope and hash, is required
void client.readJobBinaryArtifactChunk('trace',0);
const workspace=await createNodeWorkspace({root:'/operator/workspace',binaryArtifacts:true});
const source:BinaryArtifactSource|undefined=await workspace.captureBinaryFile?.('trace.bin');void source;
const host=createPluginHost({jobs:true,binaryArtifacts:true,workspace});void host.activate(plugin);
void host.binaryArtifactCapabilities();void host.listJobBinaryArtifacts(reference.jobId);
void host.readJobBinaryArtifactChunk(reference.jobId,'trace',reference.artifact.revision,0,1024);
void createWorkspaceServer({root:'/operator/workspace',workspaceId:crypto.randomUUID(),token:'explicit-operator-runtime-value-only',jobs:true,binaryArtifacts:true,notice:{id:'example',version:'1',text:'Operator notice'}});
