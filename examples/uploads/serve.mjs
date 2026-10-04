import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {definePlugin} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
const here=path.dirname(fileURLToPath(import.meta.url)),source=path.resolve(here,'../../src'),directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-upload-browser-'))),root=path.join(directory,'workspace');
const token=randomBytes(32).toString('hex'),pluginId='browser-upload-example',artifactSha256=createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');let server,config,origin,closing=false;
const web=createServer(async(req,res)=>{
  try{
    if(req.method==='POST'&&req.url==='/close'&&req.headers.origin===origin&&req.headers['x-fixture-token']===token){res.writeHead(200);res.end('Closing');setImmediate(()=>void close());return;}
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(req.url==='/config.json'&&config){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(config));return;}
    let file,type='text/javascript; charset=utf-8';
    if(req.url==='/'){file=path.join(here,'browser.html');type='text/html; charset=utf-8';}else if(req.url==='/browser.mjs')file=path.join(here,'browser.mjs');else if(/^\/sdk\/[a-z0-9-]+\.mjs$/.test(req.url))file=path.join(source,req.url.slice(5));else{res.writeHead(404);res.end();return;}
    res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(await fs.readFile(file));
  }catch{res.writeHead(404);res.end();}
});
async function close(){if(closing)return;closing=true;await server?.close();await new Promise(resolve=>{web.close(resolve);web.closeAllConnections();});assert.equal(path.dirname(directory),await fs.realpath(os.tmpdir()));assert.ok(path.basename(directory).startsWith('dds-upload-browser-'));await fs.rm(directory,{recursive:true});console.log('Upload browser fixture cleaned');}
try{
  await fs.mkdir(path.join(root,'input'),{recursive:true});await new Promise((resolve,reject)=>{web.once('error',reject);web.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+web.address().port;
  const plugin=definePlugin({manifestVersion:2,id:pluginId,name:'Browser upload example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','workspace.write'],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}},ctx=>ctx.registerCommand({id:'collect',title:'Collect selected upload'},async(input,{job})=>{await job.addBinaryArtifact({id:'input',path:input.path});return{artifact:'input'};}));
  server=await createWorkspaceServer({root,workspaceId:randomUUID(),token,plugins:[{plugin,artifactSha256}],grants:['workspace.read','workspace.write'],jobs:true,binaryArtifacts:true,timeoutMs:30000,allowedOrigins:[origin],uploads:{directory:path.join(directory,'staging'),principalId:'browser-example',roots:['input'],fileSystem:'local'},notice:{id:'browser-upload',version:'1',text:'Disposable selected-file browser upload fixture.'}});
  config={url:server.url,token,pluginId,artifactSha256};console.log('Upload browser example: '+origin);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close());
}catch(error){await close();throw error;}
