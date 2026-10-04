import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {createArtifactFixture} from './host.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)),source=path.resolve(here,'../../src');let fixture,closing=false;
const web=createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    if(req.url==='/config.json'&&fixture){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(fixture.config));return;}
    let file,type='text/javascript; charset=utf-8';
    if(req.url==='/'){file=path.join(here,'browser.html');type='text/html; charset=utf-8';}
    else if(['/browser.mjs','/worker.mjs'].includes(req.url))file=path.join(here,req.url.slice(1));
    else if(/^\/sdk\/[a-z0-9-]+\.mjs$/.test(req.url))file=path.join(source,req.url.slice(5));
    else{res.writeHead(404);res.end();return;}
    res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(await fs.readFile(file));
  }catch{res.writeHead(404);res.end();}
});
async function close(){if(closing)return;closing=true;await fixture?.close();await new Promise(resolve=>{web.close(resolve);web.closeAllConnections();});}
try{await new Promise((resolve,reject)=>{web.once('error',reject);web.listen(0,'127.0.0.1',resolve);});const origin='http://127.0.0.1:'+web.address().port;fixture=await createArtifactFixture({allowedOrigins:[origin]});console.log('Streaming browser example: '+origin);for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void close());}catch(error){await close();throw error;}
