import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {canonical, digest, fail, fields, identifier, integer, scope, jsonCopy} from './workflow-internals.mjs';

const inside=(root,target)=>{const r=path.relative(root,target);return r==='' || r!=='..' && !r.startsWith('..'+path.sep) && !path.isAbsolute(r);};
const same=(a,b)=>a.dev===b.dev && a.ino===b.ino;
async function directory(value) {
  if(typeof value!=='string' || !path.isAbsolute(value)) fail('INVALID','Absolute owner directory required');
  const s=await fs.lstat(value); if(!s.isDirectory() || s.isSymbolicLink()) fail('INVALID','Real directory required');
  return {path:await fs.realpath(value),stat:s};
}
async function bytes(file,max) {
  const s=await fs.lstat(file); if(!s.isFile() || s.isSymbolicLink() || s.nlink!==1 || s.size>max) fail('INVALID','Expected bounded regular file');
  const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW ?? 0));
  try {
    const opened=await h.stat(); if(!same(s,opened) || opened.nlink!==1 || opened.size>max) fail('CONFLICT','File changed');
    const data=Buffer.alloc(opened.size); let offset=0;
    while(offset<data.length){const r=await h.read(data,offset,data.length-offset,offset);if(!r.bytesRead)fail('CONFLICT','File changed');offset+=r.bytesRead;}
    const after=await h.stat(),current=await fs.lstat(file);
    if(!same(opened,current)||!same(opened,after)||current.isSymbolicLink()||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)fail('CONFLICT','File changed');
    return data;
  } finally {await h.close();}
}
const decode=data=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));
const dead=owner=>{if(owner.host!==hostname()||owner.pid===process.pid)return false;try{process.kill(owner.pid,0);return false;}catch(e){return e.code==='ESRCH';}};
function lockOwner(value){fields(value,['pid','host','token']);integer(value.pid,1,Number.MAX_SAFE_INTEGER);identifier(value.token);if(typeof value.host!=='string'||value.host.length>256)fail('INVALID','Bad owner');return value;}

/** Internal single-writer storage; never scans or removes anything outside its exact owned directory. */
export async function openOwnedJsonStore({directory:location,workspaceRoot,scope:binding,kind,maxEntries,maxBytes,recordBytes,recoverStaleLock=false}) {
  binding=jsonCopy(scope(binding)); identifier(kind); integer(maxEntries,1,512); integer(maxBytes,1024,67_108_864); integer(recordBytes,1024,4_194_304);
  if(typeof recoverStaleLock!=='boolean')fail('INVALID','Invalid recovery policy');
  const workspace=await directory(workspaceRoot),root=await directory(location);
  if(inside(workspace.path,root.path)||inside(root.path,workspace.path))fail('INVALID','Store and workspace must be disjoint');
  const marker={schemaVersion:1,kind,scope:binding,workspace:digest(canonical({path:workspace.path,dev:workspace.stat.dev,ino:workspace.stat.ino}))};
  const owner={pid:process.pid,host:hostname(),token:randomUUID()},lock=path.join(root.path,'.writer.lock');
  let closed=false,closing=false,tail=Promise.resolve(),queued=0,closePromise;
  const entries=new Map(),problems=new Map(),orphans=new Set(),unknown=[];
  async function checkRoot(){const r=await directory(root.path),w=await directory(workspace.path);if(!same(r.stat,root.stat)||!same(w.stat,workspace.stat)||r.path!==root.path||w.path!==workspace.path)fail('CONFLICT','Store or workspace changed');}
  async function owned(){if(closed)fail('DISPOSED','Store closed');await checkRoot();const value=lockOwner(decode(await bytes(lock,2048)));if(value.token!==owner.token)fail('CONFLICT','Store ownership changed');}
  async function exclusive(file,data){const h=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW ?? 0),0o600);try{await h.writeFile(data);await h.sync();}finally{await h.close();}}
  async function acquire(){
    const guard=path.join(root.path,'.recovery.lock');
    try{await fs.lstat(guard);fail('CONFLICT','Recovery in progress');}catch(e){if(e.code!=='ENOENT')throw e;}
    try{await exclusive(lock,canonical(owner));}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      if(!recoverStaleLock)fail('CONFLICT','Writer lock exists; explicit stale recovery is required');
      const old=lockOwner(decode(await bytes(lock,2048)));if(!dead(old))fail('CONFLICT','Writer is not proven dead');
      await exclusive(guard,canonical(owner));
      try{await checkRoot();const current=lockOwner(decode(await bytes(lock,2048)));if(current.token!==old.token||!dead(current))fail('CONFLICT','Writer changed');await fs.unlink(lock);await exclusive(lock,canonical(owner));}
      finally{const g=lockOwner(decode(await bytes(guard,2048)));if(g.token===owner.token)await fs.unlink(guard);}
    }
    try{await fs.lstat(guard);fail('CONFLICT','Recovery raced writer');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  async function atomic(file,data){
    await owned();const temporary=path.join(root.path,`.pending-${owner.token}-${randomUUID()}`);let created=false;
    try{
      await exclusive(temporary,data);created=true;await owned();
      try{await bytes(file,recordBytes+4096);}catch(e){if(e.code!=='ENOENT')throw e;}
      await fs.rename(temporary,file);created=false;
      if(process.platform!=='win32'){const h=await fs.open(root.path,constants.O_RDONLY);try{await h.sync();}finally{await h.close();}}
      await owned();
    }finally{if(created){await owned();await bytes(temporary,recordBytes+4096);await fs.unlink(temporary);}}
  }
  const recordFile=id=>path.join(root.path,id+'.json');
  const envelope=value=>canonical({schemaVersion:1,sha256:digest(canonical(value,recordBytes)),value},recordBytes+4096);
  async function readOne(id){
    const raw=await bytes(recordFile(id),recordBytes+4096),e=decode(raw);fields(e,['schemaVersion','sha256','value']);
    if(e.schemaVersion!==1||e.sha256!==digest(canonical(e.value,recordBytes)))fail('CORRUPT','Stored digest mismatch');
    return {value:jsonCopy(e.value,recordBytes),bytes:raw.length};
  }
  try{
    const before=await fs.readdir(root.path);if(before.length && !before.includes('.dds-store.json'))fail('CONFLICT','Nonempty directory is not this store');
    await acquire();
    try{if(canonical(decode(await bytes(path.join(root.path,'.dds-store.json'),4096)))!==canonical(marker))fail('CONFLICT','Store binding changed');}
    catch(e){if(e.code!=='ENOENT')throw e;await exclusive(path.join(root.path,'.dds-store.json'),canonical(marker));}
    const files=await fs.readdir(root.path);if(files.length>maxEntries+128)fail('LIMIT','Store entry budget');
    for(const name of files){
      if(['.dds-store.json','.writer.lock'].includes(name))continue;
      if(/^\.pending-[a-f0-9-]{36}-[a-f0-9-]{36}$/.test(name)){orphans.add(name);continue;}
      if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/.test(name)){unknown.push(name);continue;}
      const id=name.slice(0,-5);
      try{entries.set(id,await readOne(id));}catch(e){problems.set(id,e.code ?? 'CORRUPT');}
    }
    if(entries.size+problems.size>maxEntries||[...entries.values()].reduce((n,e)=>n+e.bytes,0)>maxBytes)fail('LIMIT','Stored quota exceeded');
  }catch(e){try{const o=lockOwner(decode(await bytes(lock,2048)));if(o.token===owner.token)await fs.unlink(lock);}catch{}throw e;}
  function enqueue(action){if(closed||closing)fail('DISPOSED','Store closed');if(queued>=64)fail('LIMIT','Store queue full');queued++;const p=tail.then(action);tail=p.catch(()=>{}).finally(()=>{queued--;});return p;}
  return Object.freeze({
    async get(id){identifier(id);return enqueue(async()=>{await owned();if(problems.has(id))return null;if(!entries.has(id))return null;try{const r=await readOne(id);entries.set(id,r);return r.value;}catch(e){problems.set(id,e.code ?? 'CORRUPT');entries.delete(id);return null;}});},
    async list(){return enqueue(async()=>{await owned();return [...entries.keys()];});},
    async set(id,value){identifier(id);const data=envelope(value);return enqueue(async()=>{
      await owned();const old=entries.get(id);if(!old&&!problems.has(id)&&entries.size+problems.size>=maxEntries)fail('LIMIT','Store entry quota');
      const size=Buffer.byteLength(data);if([...entries.values()].reduce((n,e)=>n+e.bytes,0)-(old?.bytes??0)+size>maxBytes)fail('LIMIT','Store byte quota');
      await atomic(recordFile(id),data);entries.set(id,{value:jsonCopy(value,recordBytes),bytes:size});problems.delete(id);
    });},
    async remove(id){identifier(id);return enqueue(async()=>{await owned();if(!entries.has(id)&&!problems.has(id))return false;await bytes(recordFile(id),recordBytes+4096);await fs.unlink(recordFile(id));entries.delete(id);problems.delete(id);return true;});},
    async cleanup(){return enqueue(async()=>{await owned();const removed=[],preserved=[...unknown];for(const name of [...orphans,...[...problems.keys()].map(id=>id+'.json')]){try{await bytes(path.join(root.path,name),recordBytes+4096);await fs.unlink(path.join(root.path,name));removed.push(name);orphans.delete(name);problems.delete(name.slice(0,-5));}catch{preserved.push(name);}}return {removed,preserved};});},
    inspect(){return {entries:entries.size,bytes:[...entries.values()].reduce((n,e)=>n+e.bytes,0),problems:[...problems.keys()],orphans:orphans.size,unknown:unknown.length,queued,closed,directorySynced:process.platform!=='win32'};},
    close(){if(closePromise)return closePromise;closing=true;return closePromise=(async()=>{await tail;await owned();await fs.unlink(lock);closed=true;})();},
  });
}
