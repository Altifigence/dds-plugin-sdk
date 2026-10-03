import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createWorkspaceServer,createProcessBackend} from '@altifigence/dds-plugin-sdk/workspace-node';
import plugin from './plugin.mjs';

const root=path.resolve(process.argv[2]??fileURLToPath(new URL('./project',import.meta.url)));
const token=process.env.DDS_WORKSPACE_TOKEN; // Explicit operator secret: no default or console output.
const workspaceId=process.env.DDS_WORKSPACE_ID??'a784ff42-e986-47b1-9140-b10f8ba68ca8';
const source=await readFile(new URL('./plugin.mjs',import.meta.url));
// Example identity covers this single module only. Production: use the packed artifact SHA-256.
const artifactSha256=createHash('sha256').update(source).digest('hex');
const licenseText=await readFile(new URL('./LICENSE',import.meta.url),'utf8');
const server=await createWorkspaceServer({root,workspaceId,name:'My user workspace',token,
  plugins:[{plugin,artifactSha256,licenseText}],grants:['workspace.read','workspace.write','backend.invoke'],
  backends:{'module-counter':createProcessBackend({executable:process.execPath,args:[fileURLToPath(new URL('./tool.mjs',import.meta.url))],cwd:root,env:{}})},
  notice:{id:'example-user-host',version:'1',text:'This operator-configured host reads and edits this workspace and runs its trusted example plugin and module-counter tool as the host OS user. Plugin code is not sandboxed. Review the plugin license and grant only the access you intend.'},
  host:process.env.DDS_WORKSPACE_BIND??'127.0.0.1',port:Number(process.env.DDS_WORKSPACE_PORT??4777),
});
console.log(`Workspace server: ${server.url}`);
console.log(`Workspace ID: ${server.workspaceId}; generation: ${server.generation}`);
console.log('Use the explicit DDS_WORKSPACE_TOKEN in the client; it is never printed.');
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await server.close();});
