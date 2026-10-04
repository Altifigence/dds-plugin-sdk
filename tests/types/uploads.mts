import {uploadFile,parseUploadSpec,parseUploadStatus,type UploadSpec,type UploadStatus} from '@altifigence/dds-plugin-sdk/uploads';
import {createNodeUploadStore,createNodeUploadSource,type NodeUploadConfiguration} from '@altifigence/dds-plugin-sdk/uploads-node';
import {createBrowserUploadSource} from '@altifigence/dds-plugin-sdk/uploads-browser';
import {createNodeWorkspace,createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
async function types(){
  const uploads:NodeUploadConfiguration={directory:'/operator/staging',principalId:'operator',roots:['input'],fileSystem:'local'};
  const workspace=await createNodeWorkspace({root:'/operator/workspace'}),scope={projectId:crypto.randomUUID(),sessionId:crypto.randomUUID()};
  const store=await createNodeUploadStore({...uploads,workspace,scope,authorize:spec=>spec.pluginId==='plugin'});const spec:UploadSpec=parseUploadSpec({});let status:UploadStatus=await store.begin(spec);
  status=await store.query({uploadId:spec.uploadId,pluginId:spec.pluginId,artifactSha256:spec.artifactSha256,recover:true});await store.write(status.reference,{offset:0,data:'eA==',sha256:''});await store.abort(status.reference);await store.prune();store.inspect();await store.close();
  const server=await createWorkspaceServer({root:'/operator/workspace',workspaceId:scope.projectId,token:'test',uploads,notice:{id:'test',version:'1',text:'test'}}),client=createWorkspaceClient({url:server.url,token:'test'});await client.connect();
  await client.getUploadCapabilities();status=await client.beginUpload(spec);status=await client.writeUploadChunk(status.reference,{offset:0,data:'eA==',sha256:''});status=await client.commitUpload(status.reference);await client.abortUpload(status.reference);
  const source=await createNodeUploadSource({path:'/selected/input.bin'});await uploadFile(client,source,{uploadId:spec.uploadId,pluginId:spec.pluginId,artifactSha256:spec.artifactSha256,path:spec.path,expectedRevision:null,recover:true,onProgress:p=>console.log(p.phase,p.completed)});
  const browser=createBrowserUploadSource(new File(['data'],'input'));await browser.read(0,4);parseUploadStatus(status);server.revokeUploads();await server.close();
}
void types;
