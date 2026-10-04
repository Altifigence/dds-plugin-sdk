import {createWorkspaceClient, type WorkspaceConditionalFile, type WorkspaceFileCapabilities, type WorkspaceFileRevision} from '@altifigence/dds-plugin-sdk/workspace-client';
const client=createWorkspaceClient({url:'http://localhost:1234',token:'fixture-token-012345678901234567890'});
await client.connect();
const capabilities:WorkspaceFileCapabilities=await client.getFileCapabilities();
const metadata:WorkspaceFileRevision=await client.getFileRevision('file.txt');
const result:WorkspaceConditionalFile=await client.readFileIfChanged(metadata.path,metadata.revision);
if (!result.notModified) console.log(result.content);
else {
  // @ts-expect-error unchanged replies have no body
  console.log(result.content);
}
// @ts-expect-error conditional reads need an explicit previous revision or null
await client.readFileIfChanged('file.txt');
// @ts-expect-error capabilities are immutable
capabilities.revision=false;
client.dispose();
