import {readFile,readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
const root=new URL('./',import.meta.url),source=new URL('../../src/',import.meta.url),modules=new Set((await readdir(source)).filter(name=>/^[a-z0-9-]+\.mjs$/.test(name)));
const files=new Map([['/',['browser.html','text/html; charset=utf-8']],['/browser.mjs',['browser.mjs','text/javascript; charset=utf-8']],['/browser.css',['browser.css','text/css; charset=utf-8']]]);
const server=createServer(async(request,response)=>{
  try{
    if(request.method!=='GET'){response.writeHead(405).end();return;}
    let entry=files.get(request.url),base=root;
    if(!entry&&request.url.startsWith('/sdk/')&&modules.has(request.url.slice(5))){entry=[request.url.slice(5),'text/javascript; charset=utf-8'];base=source;}
    if(!entry){response.writeHead(404).end();return;}
    response.writeHead(200,{'content-type':entry[1],'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"}).end(await readFile(new URL(entry[0],base)));
  }catch{response.writeHead(404).end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
console.log('Conformance browser: http://127.0.0.1:'+server.address().port);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();server.closeAllConnections();});
