import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {createPluginHost} from './index.mjs';
import {createWorkspaceServer} from './workspace-node.mjs';
import {createWorkspaceClient} from './workspace-client.mjs';
import {createNodeJobStore} from './job-storage-node.mjs';
import {createNodeArtifactStore} from './artifact-storage-node.mjs';
import {createNodeWorkspaceEditJournal} from './workspace-edits-node.mjs';
import {createSettingsStore} from './settings.mjs';
import * as localization from './localization.mjs';
import * as testing from './testing.mjs';
import * as diagnostics from './diagnostics.mjs';
import * as development from './devtools.mjs';
import {fixtureBytes} from './conformance-workspace.mjs';
import {fixturePlugin,fixtureManifest,fixtureDocument,verify} from './conformance-host.mjs';
import {SDK_VERSION} from './version.mjs';
import {CONFORMANCE_FEATURES} from './conformance-catalog.mjs';

// Call only for deliberately created temporary roots, and verify the exact parent before removal.
async function removeOwned(directory,parent){
  const stat=await fs.lstat(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Changed conformance directory');
  const resolved=await fs.realpath(directory);if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('dds-conformance-'))throw Error('Changed conformance boundary');
  await fs.rm(resolved,{recursive:true});
}
async function temporary(){const parent=await fs.realpath(os.tmpdir());return {parent,directory:await fs.realpath(await fs.mkdtemp(path.join(parent,'dds-conformance-')))};}

/** Fresh synthetic real HTTP workspace; no user root, network endpoint or executable is accepted. */
export async function createConformanceWorkspace({signal}={}){
  const {parent,directory}=await temporary(),root=path.join(directory,'workspace'),workspaceId=randomUUID(),token=randomBytes(32).toString('hex');
  const artifactSha256='a'.repeat(64);let server,client,store,artifacts,journal,disposed=false,transportFault=null;
  let requestBytes=0,responseBytes=0,requests=0,writes=0;
  const plugin=fixturePlugin(c=>c.registerCommand({id:'capture',title:'Capture'},async(_input,{job})=>{await job.addBinaryArtifact({id:'binary',path:'fixture.bin'});await job.addArtifact({id:'text',path:'fixture.txt'});return {captured:true};}),{permissions:['workspace.read','workspace.write']});
  async function start(){
    signal?.throwIfAborted();
    store=await createNodeJobStore({directory:path.join(directory,'jobs'),workspaceRoot:root,workspaceId});
    artifacts=await createNodeArtifactStore({jobStore:store});
    journal=await createNodeWorkspaceEditJournal({directory:path.join(directory,'edits'),workspaceRoot:root,workspaceId});
    server=await createWorkspaceServer({root,workspaceId,token,plugins:[{plugin,artifactSha256}],grants:['workspace.read','workspace.write'],jobs:true,binaryArtifacts:true,jobStorage:{store,artifacts},projects:{roots:[''],fileSystem:'local'},uploads:{directory:path.join(directory,'uploads'),principalId:'fixture-operator',roots:[''],fileSystem:'local'},notice:{id:'conformance',version:'1',text:'Disposable synthetic conformance fixture'}});
    client=createWorkspaceClient({url:server.url,token,fetch:async(url,options)=>{
      requests++;requestBytes+=Buffer.byteLength(options.body??'');
      const fault=transportFault;transportFault=null;
      if(fault==='disconnect')throw new TypeError('Synthetic transport interruption');
      const response=await fetch(url,options),bytes=new Uint8Array(await response.arrayBuffer());responseBytes+=bytes.byteLength;
      if(fault==='malformed')return new Response('{"unbound":true}',{status:200,headers:response.headers});
      return new Response(bytes,{status:response.status,headers:response.headers});
    }});
    await client.connect();signal?.throwIfAborted();
  }
  async function stop(){client?.dispose();await server?.close();await journal?.close();await artifacts?.close();await store?.close();}
  try{
    await fs.mkdir(root);await fs.writeFile(path.join(root,'fixture.txt'),fixtureDocument.text);await fs.writeFile(path.join(root,'fixture.bin'),fixtureBytes());
    await start();
    return Object.freeze({get client(){return client;},get journal(){return journal;},artifactSha256,
      async writeFixture(content){if(disposed)throw Error('Disposed fixture');await fs.writeFile(path.join(root,'fixture.txt'),content);writes+=Buffer.byteLength(content);},
      async restart(){if(disposed)throw Error('Disposed fixture');await stop();await start();},
      revokeProjects(){server.revokeProjects();},revokeUploads(){server.revokeUploads();},
      failNextRequest(kind){if(!['disconnect','malformed'].includes(kind))throw new TypeError('Invalid fixture fault');transportFault=kind;},
      metrics(){return {requests,requestBytes,responseBytes,fixtureWriteBytes:writes};},
      async dispose(){if(disposed)return;disposed=true;await stop();await removeOwned(directory,parent);},
    });
  }catch(error){await stop();await removeOwned(directory,parent);throw error;}
}

export function createSdkConformanceOptions(){
  return {identity:{host:'DDS reference SDK',version:SDK_VERSION,runtime:`Node ${process.version}`,platform:`${process.platform}-${process.arch}`},features:[...CONFORMANCE_FEATURES],adapters:{
    host:createPluginHost,settings:createSettingsStore,workspace:createConformanceWorkspace,localization,testing,diagnostics,
    async development(){const {parent,directory}=await temporary();return {api:development,directory:path.join(directory,'project'),async dispose(){await removeOwned(directory,parent);}};},
  }};
}
