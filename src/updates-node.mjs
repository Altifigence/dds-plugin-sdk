import {constants} from 'node:fs';
import {lstat,realpath,open,mkdir,readdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {canonical,clone,digest,fail,fields,sha} from './release-internals.mjs';

const LIMIT=128*1024, MAX_RECORDS=256, MAX_TOTAL=8*1024*1024;
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
async function directory(value){
  if(typeof value!=='string'||!path.isAbsolute(value))fail('INVALID','Expected an absolute directory');
  const before=await lstat(value),root=await realpath(value),after=await lstat(root);
  if(!before.isDirectory()||before.isSymbolicLink()||!same(before,after))fail('CONFLICT','Expected a stable real directory');
  return {root,stat:after};
}
async function read(file,limit=LIMIT){
  const info=await lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>limit)fail('INVALID','Expected bounded regular journal file');
  const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const before=await handle.stat();if(!same(info,before)||before.size!==info.size)fail('CONFLICT','Journal file changed');const bytes=Buffer.alloc(info.size+1);let size=0;while(size<bytes.length){const part=await handle.read(bytes,size,bytes.length-size,size);if(!part.bytesRead)break;size+=part.bytesRead;}const after=await handle.stat(),named=await lstat(file);if(size!==info.size||!same(info,named)||after.size!==info.size||after.mtimeMs!==before.mtimeMs||named.isSymbolicLink())fail('CONFLICT','Journal file changed');return bytes.subarray(0,size);}finally{await handle.close();}
}
function decode(bytes){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('CORRUPT','Journal JSON is corrupt');}}
function record(value){
  fields(value,['schemaVersion','revision','activeSha256','settingsSha256','phase','plan','disposition']);
  if(value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||value.revision<1||!['idle','staged','approved','preparing','activated','failed'].includes(value.phase))fail('CORRUPT','Invalid journal record');
  sha(value.activeSha256);sha(value.settingsSha256);canonical(value,LIMIT);return value;
}
async function latest(root){
  const files=(await readdir(root)).filter(x=>/^\d{6}\.json$/.test(x)).sort();
  if(files.length>MAX_RECORDS)fail('LIMIT','Journal record limit exceeded');
  let result=null,total=0;
  for(let n=0;n<files.length;n++){
    if(files[n]!==`${String(n+1).padStart(6,'0')}.json`)fail('CORRUPT','Journal revision gap');
    const bytes=await read(path.join(root,files[n]));total+=bytes.length;if(total>MAX_TOTAL)fail('LIMIT','Journal byte budget exceeded');
    const envelope=decode(bytes);fields(envelope,['schemaVersion','sha256','record']);
    if(envelope.schemaVersion!==1||digest(canonical(envelope.record,LIMIT))!==envelope.sha256)fail('CORRUPT','Journal digest mismatch');
    result=record(envelope.record);if(result.revision!==n+1)fail('CORRUPT','Journal revision mismatch');
  }
  return {record:result,total};
}
/** Readback is available without a writer; a partial/corrupt tail is reported, never replayed. */
export async function inspectNodeUpdateJournal(options){
  fields(options,['directory']);const {root}=await directory(options.directory);
  try{const value=await latest(root);return {state:'readable',...value};}catch(error){return {state:'unreadable',record:null,errorCode:error.code??'IO_ERROR'};}
}
/** Dedicated operator-owned directory outside the workspace. Records are bounded and append-only. */
export async function createNodeUpdateJournal(options){
  fields(options,['directory','workspaceRoot'],['recoverStaleLock']);
  const workspace=await directory(options.workspaceRoot);
  if(typeof options.directory!=='string'||!path.isAbsolute(options.directory))fail('INVALID','Expected an absolute journal directory');
  const prospective=path.join(await realpath(path.dirname(options.directory)),path.basename(options.directory));
  const proposedRelative=path.relative(workspace.root,prospective);
  if(proposedRelative===''||proposedRelative!=='..'&&!proposedRelative.startsWith('..'+path.sep)&&!path.isAbsolute(proposedRelative))fail('INVALID','Keep the update journal outside the workspace');
  try{await mkdir(options.directory);}catch(error){if(error.code!=='EEXIST')throw error;}
  const binding=await directory(options.directory),root=binding.root;
  const relative=path.relative(workspace.root,root);
  if(relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))fail('INVALID','Keep the update journal outside the workspace');
  const lock=path.join(root,'.writer.lock'),recovery=path.join(root,'.recovery.lock');
  const owner={pid:process.pid,host:hostname(),token:randomUUID()};let closed=false,busy=false;
  const exclusive=async(file,bytes)=>{const handle=await open(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW??0),0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}};
  const acquire=async()=>{try{await lstat(recovery);fail('CONFLICT','Journal recovery is already in progress');}catch(error){if(error.code!=='ENOENT')throw error;}await exclusive(lock,canonical(owner));};
  try{await acquire();}catch(error){
    if(error.code!=='EEXIST'||options.recoverStaleLock!==true)throw error;
    await exclusive(recovery,canonical(owner));
    try{
      const old=decode(await read(lock,2048));fields(old,['pid','host','token']);
      if(old.host!==hostname()||!Number.isSafeInteger(old.pid)||old.pid<1)fail('CONFLICT','Cannot prove stale lock ownership');
      let dead=false;try{process.kill(old.pid,0);}catch(probe){dead=probe.code==='ESRCH';}
      if(!dead)fail('CONFLICT','Writer may still be alive');
      const again=decode(await read(lock,2048));if(canonical(again)!==canonical(old))fail('CONFLICT','Writer changed');
      await unlink(lock);await exclusive(lock,canonical(owner));
    }finally{await unlink(recovery);}
  }
  const check=async()=>{
    if(closed)fail('DISPOSED','Journal closed');const next=await directory(root);if(!same(next.stat,binding.stat))fail('CONFLICT','Journal directory changed');
    if(canonical(decode(await read(lock,2048)))!==canonical(owner))fail('CONFLICT','Journal ownership changed');
  };
  try{await latest(root);}catch(error){await unlink(lock);throw error;}
  return {
    async read(){await check();return clone((await latest(root)).record);},
    async compareAndSwap(expected,next){
      if(busy)fail('CONFLICT','Concurrent journal write');busy=true;
      try{await check();const current=await latest(root);if((current.record?.revision??0)!==expected||next.revision!==expected+1)fail('CONFLICT','Journal revision changed');record(next);if(next.revision>MAX_RECORDS)fail('LIMIT','Archive this journal before starting a new one');const bytes=canonical({schemaVersion:1,sha256:digest(canonical(next,LIMIT)),record:next},LIMIT);if(current.total+Buffer.byteLength(bytes)>MAX_TOTAL)fail('LIMIT','Journal byte budget exceeded');await exclusive(path.join(root,`${String(next.revision).padStart(6,'0')}.json`),bytes);if(process.platform!=='win32'){const handle=await open(root,constants.O_RDONLY);try{await handle.sync();}finally{await handle.close();}}return clone(next);}finally{busy=false;}
    },
    async close(){if(closed)return;if(busy)fail('CONFLICT','Journal write running');await check();await unlink(lock);closed=true;},
  };
}
