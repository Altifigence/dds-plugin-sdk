import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
const here=path.dirname(fileURLToPath(import.meta.url)),source=path.dirname(fileURLToPath(import.meta.resolve('@altifigence/dds-plugin-sdk/tool-streams')));
const server=createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    let file,type='text/javascript; charset=utf-8';
    if(req.url==='/'){file=path.join(here,'browser.html');type='text/html; charset=utf-8';}
    else if(req.url==='/browser.mjs')file=path.join(here,'browser.mjs');
    else if(/^\/sdk\/[a-z0-9-]+\.mjs$/.test(req.url))file=path.join(source,req.url.slice(5));
    else{res.writeHead(404);res.end();return;}
    const bytes=await readFile(file);res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(bytes);
  }catch{res.writeHead(404);res.end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
console.log('Tool stream browser example: http://127.0.0.1:'+server.address().port);
let closed=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{if(!closed){closed=true;server.close();server.closeAllConnections();}});
