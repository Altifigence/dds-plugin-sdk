import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';

const example=path.dirname(fileURLToPath(import.meta.url)),source=path.resolve(example,'../../src');
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-browser-')));
const token=randomUUID()+randomUUID();let workspace,config,closing=false;
const web=createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(req.url==='/config.json'&&config){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(config));return;}
    let file,type='text/javascript; charset=utf-8';
    if(req.url==='/'){file=path.join(example,'browser.html');type='text/html; charset=utf-8';}
    else if(req.url==='/browser.mjs')file=path.join(example,'browser.mjs');
    else if(/^\/sdk\/[a-z0-9-]+\.mjs$/.test(req.url))file=path.join(source,req.url.slice(5));
    else{res.writeHead(404);res.end();return;}
    const body=await fs.readFile(file);res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);
  }catch{res.writeHead(404);res.end();}
});
async function close(){
  if(closing)return;closing=true;await workspace?.close();await new Promise(resolve=>{web.close(resolve);web.closeAllConnections();});
  assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-project-browser-'));await fs.rm(root,{recursive:true});
}
try{
  await fs.mkdir(path.join(root,'rtl'));await new Promise((resolve,reject)=>{web.once('error',reject);web.listen(0,'127.0.0.1',resolve);});
  const origin='http://127.0.0.1:'+web.address().port;
  workspace=await createWorkspaceServer({root,workspaceId:randomUUID(),token,notice:{id:'browser-example',version:'1',text:'Disposable local browser example'},projects:{roots:['rtl'],fileSystem:'local'},allowedOrigins:[origin]});
  config={url:workspace.url,token};console.log('Project browser example: '+origin);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().catch(error=>{console.error(error.message);process.exitCode=1;});});
}catch(error){await close();throw error;}
