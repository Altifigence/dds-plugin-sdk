import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {WINDOWS_DEVICE_COMPONENT} from './patterns.mjs';

export const devJson = value => `${JSON.stringify(value, null, 2)}\n`;
export const devHash = value => createHash('sha256').update(value).digest('hex');
export function devFailure(code, message) {const failure=new Error(message);failure.code=code;return failure;}
export function devOptions(value, keys) {
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw devFailure('invalid_options','Invalid development options');
  for(const key of Reflect.ownKeys(value)){
    const d=Object.getOwnPropertyDescriptor(value,key);
    if(!keys.includes(key)||!d?.enumerable||!('value'in d))throw devFailure('invalid_options','Invalid development options');
  }
}
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
export async function realDirectory(directory) {
  if(typeof directory!=='string'||!directory||!directory.isWellFormed()||/[\u0000-\u001f]/u.test(directory))throw devFailure('invalid_path','Expected a local directory');
  const absolute=path.resolve(directory),info=await fs.lstat(absolute),real=await fs.realpath(absolute);
  if(!info.isDirectory()||info.isSymbolicLink()||!samePath(absolute,real))throw devFailure('unsafe_path','Expected an unlinked real directory');
  return real;
}
export async function newDirectoryPath(directory) {
  if(typeof directory!=='string'||!directory||!directory.isWellFormed()||/[\u0000-\u001f]/u.test(directory))throw devFailure('invalid_path','Provide a new plugin directory');
  const absolute=path.resolve(directory),name=path.basename(absolute);
  if(!name||/[. ]$/.test(name)||WINDOWS_DEVICE_COMPONENT.test(name))throw devFailure('invalid_path','Invalid destination name');
  return path.join(await realDirectory(path.dirname(absolute)),name);
}
export async function readDevFile(filename, maxBytes=1_048_576) {
  const before=await fs.lstat(filename);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maxBytes)throw devFailure('unsafe_file','Expected a bounded, unlinked regular development file');
  const handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{
    const opened=await handle.stat();
    if(!sameFile(before,opened)||!opened.isFile()||opened.nlink!==1||opened.size>maxBytes)throw devFailure('conflict','Development file changed while opening');
    const buffer=Buffer.alloc(maxBytes+1);let used=0;
    while(used<buffer.length){const r=await handle.read(buffer,used,buffer.length-used,used);if(!r.bytesRead)break;used+=r.bytesRead;}
    const after=await handle.stat();
    if(used>maxBytes)throw devFailure('budget_exceeded','Development file exceeds its byte limit');
    if(!sameFile(opened,after)||opened.size!==after.size||opened.mtimeMs!==after.mtimeMs||after.nlink!==1)throw devFailure('conflict','Development file changed while reading');
    try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used));}catch{throw devFailure('invalid_file','Expected UTF-8 development data');}
  }finally{await handle.close();}
}
export function checkedFiles(files) {
  if(!(files instanceof Map)||files.size<1||files.size>256)throw devFailure('budget_exceeded','Invalid generated file count');
  const result=new Map();let bytes=0;
  for(const [name,text]of [...files].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    if(typeof name!=='string'||name.length>240||name.includes('\\')||name.split('/').some(part=>!part||part==='.'||part==='..'||!/^[A-Za-z0-9_.-]+$/.test(part)||/[. ]$/.test(part)||WINDOWS_DEVICE_COMPONENT.test(part)))throw devFailure('invalid_path','Invalid generated file path');
    if(typeof text!=='string'||!text.isWellFormed()||Buffer.byteLength(text)>1_048_576)throw devFailure('budget_exceeded','Invalid generated file contents');
    bytes+=Buffer.byteLength(text);if(bytes>4_194_304)throw devFailure('budget_exceeded','Generated project exceeds 4 MiB');
    result.set(name,text);
  }
  for(const name of result.keys())for(const other of result.keys())if(other!==name&&(other.toLowerCase()===name.toLowerCase()||other.toLowerCase().startsWith(name.toLowerCase()+'/')))throw devFailure('invalid_path','Generated paths collide');
  return result;
}
export function fileInventory(files) {return [...checkedFiles(files)].map(([name,text])=>({path:name,bytes:Buffer.byteLength(text),sha256:devHash(text)}));}
export async function destinationExists(target){try{await fs.lstat(target);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}

/** Claim with mkdir; on failure remove only still-owned created entries. */
export async function writeNewDirectory(target, input, {write=(handle,text)=>handle.writeFile(text,'utf8')}={}) {
  const files=checkedFiles(input),owned=[];
  target=await newDirectoryPath(target);
  try{await fs.mkdir(target);}catch(e){if(e.code==='EEXIST')throw devFailure('conflict','Destination already exists; choose a new directory');throw e;}
  owned.push({path:target,info:await fs.lstat(target),directory:true});
  const directories=new Set(['']);
  try{
    for(const [name,text]of files){
      const parts=name.split('/');parts.pop();let relative='';
      for(const part of parts){relative=relative?relative+'/'+part:part;if(directories.has(relative))continue;
        const directory=path.join(target,relative);await fs.mkdir(directory);owned.push({path:directory,info:await fs.lstat(directory),directory:true});directories.add(relative);
      }
      const filename=path.join(target,name),handle=await fs.open(filename,'wx',0o600);
      const entry={path:filename,info:await handle.stat(),directory:false,expected:Buffer.from(text),finished:null};owned.push(entry);
      try{await write(handle,text);}finally{try{entry.finished=await handle.stat();}finally{await handle.close();}}
    }
    return target;
  }catch(failure){
    let preserved=false;
    for(const item of owned.reverse()){
      try{const current=await fs.lstat(item.path);if(!sameFile(current,item.info)||current.isSymbolicLink()){preserved=true;continue;}
        if(item.directory)await fs.rmdir(item.path);else{
          if(!item.finished||current.size!==item.finished.size||current.mtimeMs!==item.finished.mtimeMs||current.nlink!==1||current.size>item.expected.length){preserved=true;continue;}
          const actual=await fs.readFile(item.path);if(!actual.equals(item.expected.subarray(0,actual.length))){preserved=true;continue;}await fs.unlink(item.path);
        }
      }catch(e){if(e.code!=='ENOENT')preserved=true;}
    }
    const error=devFailure('write_failed',preserved?'Generated write failed; changed or additional entries were preserved for inspection':'Generated write failed; created entries were removed');
    error.cleanupPreserved=preserved;error.ioCode=typeof failure?.code==='string'?failure.code:'write_failed';throw error;
  }
}

export async function inspectGeneratedDirectory(directory, expected) {
  const root=await realDirectory(directory),files=checkedFiles(expected),found=[];
  async function visit(relative=''){
    for(const entry of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
      const name=relative?relative+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink())throw devFailure('conflict','Generated directory contains a linked entry');
      if(entry.isDirectory()){
        if(![...files.keys()].some(key=>key.startsWith(name+'/')))throw devFailure('conflict','Generated directory contains an unrelated directory');
        await visit(name);
      }else if(entry.isFile())found.push(name);else throw devFailure('conflict','Generated directory contains a non-regular entry');
      if(found.length>256)throw devFailure('budget_exceeded','Generated directory entry limit exceeded');
    }
  }
  await visit();found.sort();
  if(JSON.stringify(found)!==JSON.stringify([...files.keys()].sort()))throw devFailure('conflict','Generated file inventory differs; preserve and inspect local edits');
  for(const [name,text]of files)if(await readDevFile(path.join(root,name))!==text)throw devFailure('conflict','A generated file was edited; preserve and inspect local edits');
  return Object.freeze({root,info:await fs.lstat(root)});
}
async function removeGeneratedDirectory(directory, files) {
  await inspectGeneratedDirectory(directory,files);
  const directories=new Set();
  for(const name of files.keys()){
    await fs.unlink(path.join(directory,name));let parent=path.posix.dirname(name);
    while(parent!=='.'){directories.add(parent);parent=path.posix.dirname(parent);}
  }
  for(const name of [...directories].sort((a,b)=>b.length-a.length))await fs.rmdir(path.join(directory,name));
  await fs.rmdir(directory);
}

/** Cooperative lock + verified backup; unrelated or modified output is never replaced. */
export async function replaceGeneratedDirectory(project, files, previousFiles, verifySource) {
  project=await realDirectory(project);files=checkedFiles(files);
  const target=path.join(project,'generated'),lockPath=path.join(project,'.dds-generate.lock');
  let lock;try{lock=await fs.open(lockPath,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw devFailure('conflict','Generation lock exists; inspect a previous interrupted operation');throw e;}
  const lockInfo=await lock.stat(),suffix=randomUUID(),stage=path.join(project,'.dds-generation-'+suffix),backup=path.join(project,'.dds-generation-backup-'+suffix);
  let stageCreated=false,moved=false;
  try{
    await lock.writeFile(devJson({schemaVersion:1,pid:process.pid,stage:path.basename(stage),backup:path.basename(backup)}));
    if(previousFiles)await inspectGeneratedDirectory(target,previousFiles);
    else if(await destinationExists(target))throw devFailure('conflict','Generated destination already exists');
    await writeNewDirectory(stage,files);stageCreated=true;await verifySource();
    if(previousFiles){await inspectGeneratedDirectory(target,previousFiles);await fs.rename(target,backup);moved=true;}
    else if(await destinationExists(target))throw devFailure('conflict','Generated destination appeared during generation');
    try{await fs.rename(stage,target);stageCreated=false;}
    catch(e){if(moved&&!await destinationExists(target)){await fs.rename(backup,target);moved=false;}throw e;}
    await inspectGeneratedDirectory(target,files);
    if(moved){await removeGeneratedDirectory(backup,previousFiles);moved=false;}
    return target;
  }finally{
    let stagePreserved=false;
    try{if(stageCreated)await removeGeneratedDirectory(stage,files);}
    catch(e){stagePreserved=true;throw e;}
    finally{
      await lock.close();
      // An uncertain publication/cleanup retains the lock for explicit recovery.
      if(!moved&&!stagePreserved){const current=await fs.lstat(lockPath);if(sameFile(current,lockInfo)&&!current.isSymbolicLink())await fs.unlink(lockPath);}
    }
  }
}
