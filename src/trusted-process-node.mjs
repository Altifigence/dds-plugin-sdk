import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {canonical,clone,digest,fail,fields,identifier,integer,string,sha,immutable,aborted,interruptible,deadline} from './workflow-internals.mjs';

export async function hashToolFile(file){
  if(typeof file!=='string'||!path.isAbsolute(file))fail('INVALID','Absolute operator-owned file required');
  const before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.size>268_435_456)fail('INVALID','Tool file is not a bounded regular file');
  const h=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW ?? 0));
  try{
    const s=await h.stat();if(s.dev!==before.dev||s.ino!==before.ino)fail('CONFLICT','Tool file changed');
    const hasher=createHash('sha256'),buffer=Buffer.alloc(65_536);let offset=0;
    while(offset<s.size){const r=await h.read(buffer,0,Math.min(buffer.length,s.size-offset),offset);if(!r.bytesRead)fail('CONFLICT','Tool file changed');hasher.update(buffer.subarray(0,r.bytesRead));offset+=r.bytesRead;}
    const after=await h.stat(),current=await fs.lstat(file);if(after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs||current.dev!==s.dev||current.ino!==s.ino||current.isSymbolicLink())fail('CONFLICT','Tool file changed');
    return hasher.digest('hex');
  }finally{await h.close();}
}
export function parseTrustedProcessDefinition(input){
  // This is an operator configuration, never accepted from a plugin command payload.
  const value=clone(input);fields(value,['id','version','approved','executable','executableSha256','files','args','versionArgs','expectedVersionOutput','environment']);
  identifier(value.id);string(value.version,'tool version',96);if(value.approved!==true)fail('DENIED','Operator process approval required');
  if(!path.isAbsolute(value.executable))fail('INVALID','Absolute executable required');sha(value.executableSha256);
  if(!Array.isArray(value.files)||value.files.length>64)fail('LIMIT','Pinned file count');
  for(const file of value.files){fields(file,['path','sha256']);if(!path.isAbsolute(file.path))fail('INVALID','Absolute tool artifact required');sha(file.sha256);}
  for(const args of [value.args,value.versionArgs]){if(!Array.isArray(args)||args.length>64)fail('LIMIT','Argument count');for(const arg of args){if(typeof arg==='string')string(arg,'argument',4096);else{fields(arg,['input']);identifier(arg.input);}}}
  if(value.versionArgs.some(arg=>typeof arg!=='string'))fail('INVALID','Version probe arguments must be fixed');
  string(value.expectedVersionOutput,'version output',256);
  if(!value.environment||typeof value.environment!=='object'||Array.isArray(value.environment)||Object.keys(value.environment).length>32)fail('INVALID','Explicit process environment required');
  for(const [key,entry]of Object.entries(value.environment)){if(!/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/.test(key)||typeof entry!=='string'||entry.length>4096||entry.includes('\0'))fail('INVALID','Invalid environment');}
  return immutable(value);
}
export async function verifyTrustedProcess(input){const definition=parseTrustedProcessDefinition(input);for(const file of [{path:definition.executable,sha256:definition.executableSha256},...definition.files]){if(await hashToolFile(file.path)!==file.sha256)fail('CONFLICT','Configured tool digest changed');}return {definition,sha256:digest(canonical(definition))};}
export async function realToolWorkspace(root){if(typeof root!=='string'||!path.isAbsolute(root))fail('INVALID','Absolute workspace root required');const s=await fs.lstat(root);if(!s.isDirectory()||s.isSymbolicLink())fail('INVALID','Real workspace root required');return {root:await fs.realpath(root),dev:s.dev,ino:s.ino};}
export async function checkToolWorkspace(identity){const now=await realToolWorkspace(identity.root);if(now.root!==identity.root||now.dev!==identity.dev||now.ino!==identity.ino)fail('CONFLICT','Workspace changed');}

/** Owns only the direct child and its pipes. It is not an OS sandbox or a process-tree manager. */
export function spawnTrustedProcess(definition,args,workspace,signal){
  aborted(signal);const child=spawn(definition.executable,args,{cwd:workspace.root,env:{...definition.environment},windowsHide:true,shell:false,stdio:['pipe','pipe','pipe']});
  let ended=false,stopPromise,error=null;
  const finished=new Promise(resolve=>{child.once('error',e=>{error=e;});child.once('close',(code,terminationSignal)=>{ended=true;resolve({code,signal:terminationSignal,error:error?'PROCESS_START_FAILED':null});});});
  async function stop(){if(stopPromise)return stopPromise;return stopPromise=(async()=>{
    if(ended)return finished;child.stdin.destroy();child.kill();let timer;
    try{await Promise.race([finished,new Promise(r=>{timer=setTimeout(r,250);})]);}finally{clearTimeout(timer);}
    if(!ended){child.kill('SIGKILL');child.stdout.destroy();child.stderr.destroy();let last;try{await Promise.race([finished,new Promise(r=>{last=setTimeout(r,1000);})]);}finally{clearTimeout(last);}}
    if(!ended)fail('PROCESS_UNSETTLED','Owned child did not report close');return finished;
  })();}
  const abort=()=>{stop().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});finished.then(()=>signal?.removeEventListener('abort',abort));if(signal?.aborted)abort();
  return {child,finished,stop,inspect:()=>({pid:child.pid??null,closed:ended})};
}
export async function probeTrustedProcess(definition,workspace,parentSignal){
  const clock=deadline(parentSignal,5000);let proc;
  try{
    proc=spawnTrustedProcess(definition,definition.versionArgs,workspace,clock.signal);proc.child.stdin.end();
    let total=0,output='';const read=async(stream,stdout)=>{const decoder=new TextDecoder('utf-8',{fatal:true});for await(const chunk of stream){total+=chunk.length;if(total>16_384)fail('LIMIT','Version probe output limit');if(stdout)output+=decoder.decode(chunk,{stream:true});}if(stdout)output+=decoder.decode();};
    const reads=Promise.all([read(proc.child.stdout,true),read(proc.child.stderr,false)]);
    const [exit]=await interruptible(Promise.all([proc.finished,reads]),clock.signal);
    if(exit.code!==0||exit.error||output.trim()!==definition.expectedVersionOutput)fail('UNSUPPORTED','Configured tool version probe differs');
    return definition.version;
  }finally{clock.close();await proc?.stop();}
}
