import * as fs from 'node:fs/promises';
import {constants as flags} from 'node:fs';
import {createHash} from 'node:crypto';
import {WorkspaceError,workspaceFailure} from './workspace-values.mjs';
export const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
export const sameFileState=(a,b)=>sameFile(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
export const uploadFileIdentity=stat=>({dev:String(stat.dev),ino:String(stat.ino)});
export const matchesUploadFile=(stat,identity)=>String(stat.dev)===identity.dev&&String(stat.ino)===identity.ino;
export function uploadFileError(error){
  if(error instanceof WorkspaceError)return error;
  const codes={ENOENT:'not_found',EEXIST:'conflict',ENOTEMPTY:'conflict',EACCES:'permission_denied',EPERM:'permission_denied',ENOSPC:'budget_exceeded',EDQUOT:'budget_exceeded',EFBIG:'budget_exceeded'};
  return workspaceFailure(codes[error?.code]??'unavailable','Upload file operation failed');
}
export function uploadRegular(stat,max=Number.MAX_SAFE_INTEGER,links=1n){if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==links||stat.size>BigInt(max))throw workspaceFailure('unsafe_path','Upload data must be a bounded regular file with the expected link count');}
export async function uploadOptionalStat(file){try{return await fs.lstat(file,{bigint:true});}catch(error){if(error.code!=='ENOENT')throw error;}}
export async function readUploadMetadata(file,maximum){
  const before=await fs.lstat(file,{bigint:true});uploadRegular(before,maximum);const handle=await fs.open(file,flags.O_RDONLY|(flags.O_NOFOLLOW??0));
  try{const opened=await handle.stat({bigint:true});uploadRegular(opened,maximum);if(!sameFileState(opened,before))throw workspaceFailure('conflict','Upload metadata changed');const bytes=Buffer.alloc(Number(opened.size));let at=0;while(at<bytes.length){const read=await handle.read(bytes,at,bytes.length-at,at);if(!read.bytesRead)throw workspaceFailure('conflict','Upload metadata changed');at+=read.bytesRead;}const after=await handle.stat({bigint:true}),current=await fs.lstat(file,{bigint:true});uploadRegular(current,maximum);if(!sameFileState(after,opened)||!sameFileState(current,opened))throw workspaceFailure('conflict','Upload metadata changed');return bytes;}
  finally{await handle.close();}
}
export async function hashUploadFile(file,maximum,guard=async()=>{},expected,prefixBytes){
  await guard();const before=await fs.lstat(file,{bigint:true});uploadRegular(before,maximum);if(expected&&!sameFileState(before,expected))throw workspaceFailure('conflict','Upload bytes changed');
  const handle=await fs.open(file,flags.O_RDONLY|(flags.O_NOFOLLOW??0));
  try{
    const opened=await handle.stat({bigint:true});uploadRegular(opened,maximum);if(!sameFileState(opened,before))throw workspaceFailure('conflict','Upload bytes changed');const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0;
    const total=prefixBytes??Number(opened.size);if(!Number.isSafeInteger(total)||total<0||total>Number(opened.size))throw workspaceFailure('conflict','Upload prefix is missing');
    while(offset<total){await guard();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,total-offset),offset);if(!bytesRead)throw workspaceFailure('conflict','Upload bytes changed');offset+=bytesRead;hash.update(buffer.subarray(0,bytesRead));}
    const after=await handle.stat({bigint:true}),current=await fs.lstat(file,{bigint:true});uploadRegular(current,maximum);if(!sameFileState(after,opened)||!sameFileState(current,opened))throw workspaceFailure('conflict','Upload bytes changed');await guard();return{hash,sha256:hash.copy().digest('hex'),byteLength:offset,stat:opened};
  }finally{await handle.close();}
}
export async function syncUploadDirectory(directory){if(process.platform==='win32')return false;const handle=await fs.open(directory,flags.O_RDONLY|(flags.O_NOFOLLOW??0));try{await handle.sync();return true;}finally{await handle.close();}}
export async function writeUploadExclusive(file,bytes,check=async()=>{}){
  await check();const handle=await fs.open(file,flags.O_WRONLY|flags.O_CREAT|flags.O_EXCL|(flags.O_NOFOLLOW??0),0o600),identity=await handle.stat({bigint:true});let failure;
  try{await handle.writeFile(bytes);await handle.sync();}catch(error){failure=error;}finally{await handle.close();}
  if(failure){await check();const now=await uploadOptionalStat(file);if(now){uploadRegular(now);if(!sameFile(now,identity))throw workspaceFailure('unsafe_path','Failed upload file changed before cleanup');await fs.unlink(file);}throw failure;}
}
