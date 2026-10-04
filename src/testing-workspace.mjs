import {ErrorCode} from './limits.mjs';
import {parseWorkspacePath,parseFileContent,parseExpectedRevision} from './contracts.mjs';
import {parseBinaryArtifactRange} from './artifacts.mjs';
import {parseProjectSnapshot} from './project-watch.mjs';
import {configurationObject as object} from './configuration-values.mjs';
import {createIncrementalSha256 as createSha256} from './sha256-stream.mjs';
import {hostRuntime} from './host-runtime.mjs';
import {TEST_LIMITS,testFailure} from './testing-runtime.mjs';

const encode=text=>new TextEncoder().encode(text),hash=bytes=>{const h=createSha256();h.update(bytes);return h.digest();};
export function createMemoryWorkspace(options={}){
  object(options,[],['files','runtime','faults','authorize']);const runtime=hostRuntime(options.runtime),files=new Map(),subscriptions=new Set();let closed=false,bytes=0,handles=0;
  const authorize=options.authorize??(()=>true);if(typeof authorize!=='function')throw testFailure(ErrorCode.INVALID_CONTRACT);
  const open=()=>{if(closed)throw testFailure(ErrorCode.DISPOSED);};
  const permission=kind=>{open();if(authorize(kind)!==true)throw testFailure(ErrorCode.PERMISSION_DENIED);};
  function content(value){const data=typeof value==='string'?encode(parseFileContent(value)):value;if(!(data instanceof Uint8Array)||data.length>TEST_LIMITS.fileBytes)throw testFailure(ErrorCode.INVALID_CONTRACT);return data.slice();}
  function put(name,value){name=parseWorkspacePath(name);const data=content(value),before=files.get(name),next=bytes-(before?.data.length??0)+data.length;
    if(!before&&files.size>=TEST_LIMITS.files||next>TEST_LIMITS.workspaceBytes)throw testFailure(ErrorCode.BUDGET_EXCEEDED);
    for(const other of files.keys())if(other!==name&&(other.toLowerCase()===name.toLowerCase()||other.toLowerCase().startsWith(name.toLowerCase()+'/')||name.toLowerCase().startsWith(other.toLowerCase()+'/')))throw testFailure(ErrorCode.CONFLICT);
    files.set(name,{data,revision:hash(data)});bytes=next;return files.get(name);
  }
  const initial=options.files??{};if(!initial||typeof initial!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(initial)))throw testFailure(ErrorCode.INVALID_CONTRACT);
  for(const name of Reflect.ownKeys(initial)){const d=Object.getOwnPropertyDescriptor(initial,name);if(typeof name!=='string'||!d?.enumerable||!('value'in d))throw testFailure(ErrorCode.INVALID_CONTRACT);put(name,d.value);}
  const request=async(operation,kind,fn,options={})=>{permission(kind);object(options,[],['signal','expectedRevision']);if(options.signal!==undefined&&!(options.signal instanceof AbortSignal))throw testFailure(ErrorCode.INVALID_CONTRACT);if(options.signal?.aborted)throw testFailure(ErrorCode.CANCELLED);handles++;
    try{return await (optionsFaults?optionsFaults.invoke(operation,()=>{permission(kind);return fn();},{signal:options.signal}):Promise.resolve().then(()=>{permission(kind);if(options.signal?.aborted)throw testFailure(ErrorCode.CANCELLED);return fn();}));}finally{handles--;}};
  const optionsFaults=options.faults;
  const find=name=>{const file=files.get(name);if(!file)throw testFailure(ErrorCode.CAPABILITY_UNAVAILABLE);return file;};
  function snapshot(root=''){
    root=parseWorkspacePath(root,{allowRoot:true});const entries=[],dirs=new Set();
    for(const [name,file]of files){if(root&&!name.startsWith(root+'/'))continue;entries.push({path:name,kind:'file',size:file.data.length,revision:file.revision,fingerprint:file.revision});let parent=name.split('/').slice(0,-1).join('/');while(parent&&parent!==root){dirs.add(parent);parent=parent.split('/').slice(0,-1).join('/');}}
    for(const name of dirs)entries.push({path:name,kind:'directory',size:0,revision:null,fingerprint:hash(encode(name))});entries.sort((a,b)=>a.path<b.path?-1:1);
    return parseProjectSnapshot({version:1,root,revision:hash(encode(JSON.stringify(entries))),entries,complete:true,reasons:[],observedAt:runtime.now()});
  }
  const notify=()=>{for(const entry of [...subscriptions])try{Promise.resolve(entry.callback(snapshot(entry.root))).catch(()=>{});}catch{/* test subscriber cannot roll back a write */}};
  const port=Object.freeze({
    readFile(name,options={}){name=parseWorkspacePath(name);return request('file.read','read',()=>{const file=find(name);let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(file.data);}catch{throw testFailure(ErrorCode.INVALID_CONTRACT);}return Object.freeze({path:name,content:text,revision:file.revision});},options);},
    writeFile(name,value,options={}){name=parseWorkspacePath(name);value=parseFileContent(value);const expected=parseExpectedRevision(options.expectedRevision);return request('file.write','write',()=>{if((files.get(name)?.revision??null)!==expected)throw testFailure(ErrorCode.CONFLICT);const file=put(name,value);notify();return Object.freeze({path:name,revision:file.revision});},options);},
    listFiles(root='',options={}){root=parseWorkspacePath(root,{allowRoot:true});return request('file.list','read',()=>snapshot(root).entries.map(entry=>Object.freeze({path:entry.path,kind:entry.kind,size:entry.size,...(entry.revision?{revision:entry.revision}:{})})),options);},
    captureBinaryFile(name,options={}){name=parseWorkspacePath(name);return request('file.capture','read',()=>{const file=find(name),data=file.data.slice();return Object.freeze({path:name,revision:file.revision,byteLength:data.length,readChunk(offset,length,options={}){parseBinaryArtifactRange(offset,length,data.length);return request('file.chunk','read',()=>{const bytes=data.subarray(offset,offset+length);let raw='';for(const b of bytes)raw+=String.fromCharCode(b);return Object.freeze({offset,nextOffset:offset+bytes.length,eof:offset+bytes.length===data.length,data:btoa(raw),sha256:hash(bytes)});},options);}});},options);},
  });
  return Object.freeze({port,snapshot(root=''){permission('read');return snapshot(root);},subscribe(root,callback){permission('read');parseWorkspacePath(root,{allowRoot:true});if(typeof callback!=='function'||subscriptions.size>=32)throw testFailure(ErrorCode.INVALID_CONTRACT);const entry={root,callback};subscriptions.add(entry);return Object.freeze({dispose(){subscriptions.delete(entry);}});},setFile(name,value){open();put(name,value);notify();},removeFile(name){open();name=parseWorkspacePath(name);const file=files.get(name);if(file){bytes-=file.data.length;files.delete(name);notify();}return !!file;},inspect:()=>Object.freeze({files:files.size,bytes,subscriptions:subscriptions.size,handles}),dispose(){if(closed)return;closed=true;subscriptions.clear();for(const entry of files.values())entry.data.fill(0);files.clear();bytes=0;}});
}
