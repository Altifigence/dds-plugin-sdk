import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isSafeWorkspaceRelativePath} from './patterns.mjs';
import {workspaceFailure,WorkspaceError} from './workspace-protocol.mjs';
import {PROJECT_WATCH_LIMITS,parseProjectSnapshot} from './project-watch.mjs';
import {projectMatches} from './project-patterns.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const sameState=(a,b)=>sameIdentity(a,b)&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const metadata=stat=>hash(JSON.stringify({dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs)}));
export function projectAbort(signal){if(signal?.aborted)throw signal.reason instanceof WorkspaceError?signal.reason:workspaceFailure('cancelled','Project observation cancelled');}
export function projectFileError(error){
  if(error instanceof WorkspaceError)return error;
  if(error?.code==='ENOENT'||error?.code==='ENOTDIR')return workspaceFailure('not_found','Project entry does not exist');
  if(error?.code==='EACCES'||error?.code==='EPERM')return workspaceFailure('permission_denied','Project entry cannot be read');
  return workspaceFailure('unavailable','Project filesystem operation failed');
}

/** Bounded snapshot shared by project observation and read-only queries. */
export async function scanNodeProject(context,options,{signal,onDirectory,onFile,metrics,deadline}={}){
  const started=Date.now(),entries=[],reasons=new Set(),stop=Symbol('scan limit');
  let visited=0,bytesRead=0,filesHashed=0,serializedBytes=4_096;
  const check=()=>{projectAbort(signal);if(Date.now()-started>=options.scanTimeoutMs||deadline!==undefined&&Date.now()>=deadline){reasons.add('scan_timeout');throw stop;}};
  const add=entry=>{
    if(entries.length>=options.maxEntries){reasons.add('entry_limit');throw stop;}
    serializedBytes+=Buffer.byteLength(JSON.stringify(entry))+1;
    if(serializedBytes>PROJECT_WATCH_LIMITS.snapshotBytes){reasons.add('snapshot_bytes');throw stop;}
    entries.push(entry);
  };
  async function fingerprint(relative,stat){
    const fallback=()=>({revision:null,fingerprint:metadata(stat)});
    if(stat.size>BigInt(options.maxFileBytes)){reasons.add('file_bytes');return fallback();}
    if(stat.size>BigInt(options.maxScanBytes-bytesRead)){reasons.add('scan_bytes');return fallback();}
    const before=await context.resolve(relative);
    if(!before.stat.isFile()||before.stat.nlink!==1n||!sameState(stat,before.stat))throw workspaceFailure('conflict','Project file changed before hashing');
    const handle=await fs.open(before.target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
    try{
      const opened=await handle.stat({bigint:true});
      if(!opened.isFile()||opened.nlink!==1n||!sameState(opened,stat))throw workspaceFailure('unsafe_path','Project file identity changed');
      const digest=createHash('sha256'),buffer=Buffer.alloc(65_536),chunks=onFile?[]:null;let count=0;
      while(count<Number(opened.size)){
        check();const available=Math.min(buffer.length,Number(opened.size)-count,options.maxFileBytes-count,options.maxScanBytes-bytesRead);
        const read=await handle.read(buffer,0,available,null);if(!read.bytesRead)break;
        count+=read.bytesRead;bytesRead+=read.bytesRead;
        digest.update(buffer.subarray(0,read.bytesRead));
        chunks?.push(Buffer.from(buffer.subarray(0,read.bytesRead)));
      }
      const after=await handle.stat({bigint:true}),current=await context.resolve(relative);
      if(after.nlink!==1n||current.stat.nlink!==1n||!sameState(opened,after)||!sameState(opened,current.stat)||BigInt(count)!==opened.size)throw workspaceFailure('conflict','Project file changed while hashing');
      await context.checkRoot();check();filesHashed++;
      const revision=digest.digest('hex');return{revision,fingerprint:revision,...(chunks?{bytes:Buffer.concat(chunks)}:{})};
    }finally{await handle.close();}
  }
  async function walk(relative,depth){
    check();const before=await context.resolve(relative,{allowRoot:true});
    if(!before.stat.isDirectory())throw workspaceFailure('conflict','Project directory changed');
    await onDirectory?.(relative,before);check();
    const directory=await fs.opendir(before.target),names=[];
    try{
      for await(const entry of directory){
        check();if(++visited>PROJECT_WATCH_LIMITS.visited){reasons.add('visit_limit');throw stop;}
        names.push(entry.name);
      }
    }finally{try{await directory.close();}catch(error){if(error.code!=='ERR_DIR_CLOSED')throw error;}}
    names.sort();
    for(const name of names){
      check();const entryPath=relative?relative+'/'+name:name;
      if(!isSafeWorkspaceRelativePath(entryPath))continue;
      const local=options.root?entryPath.slice(options.root.length+1):entryPath;
      if(projectMatches(options.exclude,local))continue;
      try{
        const {stat}=await context.resolve(entryPath);
        if(stat.isDirectory()){
          if(projectMatches(options.include,local))add({path:entryPath,kind:'directory',size:0,revision:null,fingerprint:hash(JSON.stringify([String(stat.dev),String(stat.ino)]))});
          if(depth<options.maxDepth)await walk(entryPath,depth+1);else reasons.add('depth_limit');
        }else if(stat.isFile()){
          if(stat.nlink!==1n){reasons.add('unsafe_entries');continue;}
          if(!projectMatches(options.include,local))continue;
          if(stat.size>BigInt(Number.MAX_SAFE_INTEGER)){reasons.add('file_bytes');continue;}
          const {bytes,...identity}=await fingerprint(entryPath,stat);
          const entry={path:entryPath,kind:'file',size:Number(stat.size),...identity};
          add(entry);
          if(bytes)await onFile?.(entry,bytes);
          check();
        }
      }catch(error){
        if(error===stop)throw error;
        const failure=projectFileError(error);
        if(['not_found','conflict'].includes(failure.code)){reasons.add('unstable');continue;}
        if(['unsafe_path','permission_denied'].includes(failure.code)){reasons.add('unsafe_entries');continue;}
        throw failure;
      }
    }
    const after=await context.resolve(relative,{allowRoot:true});
    if(!sameIdentity(before.stat,after.stat))throw workspaceFailure('conflict','Project directory identity changed');
  }
  try{
    await context.checkRoot();projectAbort(signal);
    const root=await context.resolve(options.root,{allowRoot:true});
    if(!root.stat.isDirectory())throw workspaceFailure('invalid_request','Project root must be a directory');
    try{await walk(options.root,1);}catch(error){if(error!==stop)throw error;}
    await context.checkRoot();projectAbort(signal);
    entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const reasonList=[...reasons].sort();
    return parseProjectSnapshot({version:1,root:options.root,revision:hash(JSON.stringify({root:options.root,entries,reasons:reasonList})),entries,complete:reasons.size===0,reasons:reasonList,observedAt:Date.now()});
  }catch(error){throw projectFileError(error);}
  finally{metrics?.({visited,bytesRead,filesHashed,durationMs:Date.now()-started});}
}
