import {parseArtifactSinkCapabilities} from './artifact-transfer.mjs';
import {workspaceFailure,exactObject} from './workspace-values.mjs';

const activeHandles=new Set();
let admission=Promise.resolve();
function reserve(handle,signal){
  const result=admission.then(async()=>{
    for(const other of activeHandles)if(other===handle||typeof handle.isSameEntry==='function'&&await handle.isSameEntry(other))throw workspaceFailure('conflict','The selected file is already being written');
    checkSignal(signal);activeHandles.add(handle);
  });
  admission=result.catch(()=>{});return result;
}
const checkSignal=signal=>{if(signal?.aborted)throw workspaceFailure('cancelled','Browser storage operation cancelled');};
function handleShape(handle){
  if(!handle||handle.kind!=='file'||typeof handle.getFile!=='function'||typeof handle.createWritable!=='function')throw workspaceFailure('unsupported','This file handle does not support writable streams');
}
async function permission(handle,signal,originPrivate){
  checkSignal(signal);
  if(typeof handle.queryPermission==='function'){
    if(await handle.queryPermission({mode:'readwrite'})!=='granted')throw workspaceFailure('permission_denied','The caller must grant write access to the selected handle');
  }else if(!originPrivate)throw workspaceFailure('unsupported','This runtime cannot check selected-file permission');
  checkSignal(signal);
}
function fileSink(handle,{overwrite},originPrivate){
  handleShape(handle);
  if(typeof overwrite!=='boolean')throw workspaceFailure('invalid_request','Explicit overwrite policy is required');
  const capabilities=parseArtifactSinkCapabilities({kind:originPrivate?'opfs':'file-system-access',seek:true,readback:true,persistence:'on-commit',abort:'discard'});
  return Object.freeze({capabilities,async open({artifact,signal}){
    await permission(handle,signal,originPrivate);
    // Avoid two sessions for the same entry in this realm, including separate handles.
    await reserve(handle,signal);
    let writable,finished=false,committed=false,offset=0,initial;
    const current=async operationSignal=>{checkSignal(operationSignal);if(finished&&!committed)throw workspaceFailure('disposed','Browser sink has closed');await permission(handle,operationSignal,originPrivate);};
    const release=()=>activeHandles.delete(handle);
    try{
      initial=await handle.getFile();checkSignal(signal);
      if(!overwrite&&initial.size!==0)throw workspaceFailure('conflict','Selected destination is not empty; explicit overwrite is required');
      writable=await handle.createWritable({keepExistingData:false});checkSignal(signal);
      return Object.freeze({
        async write({offset:at,bytes,signal:writeSignal}){
          await current(writeSignal);
          if(finished||at!==offset||!(bytes instanceof Uint8Array)||bytes.length>65_536||offset+bytes.length>artifact.byteLength)throw workspaceFailure('invalid_request','Invalid sequential browser write');
          await writable.write(bytes);offset+=bytes.length;checkSignal(writeSignal);
        },
        async commit({signal:commitSignal}){
          await current(commitSignal);
          if(finished||offset!==artifact.byteLength)throw workspaceFailure('conflict','Cannot commit incomplete browser download');
          // This catches ordinary intervening writes; browser APIs do not provide OS-level CAS.
          const now=await handle.getFile();checkSignal(commitSignal);
          if(now.size!==initial.size||now.lastModified!==initial.lastModified)throw workspaceFailure('conflict','Selected destination changed during transfer');
          await writable.close();committed=true;finished=true;
          // Keep the local reservation through final readback. abort() also releases it.
        },
        async readback({signal:readSignal}){
          await current(readSignal);if(!committed)throw workspaceFailure('conflict','Browser download has not committed');
          const snapshot=await handle.getFile();checkSignal(readSignal);
          // A File is a snapshot; read bounded slices, never the whole ArrayBuffer.
          return Object.freeze({byteLength:snapshot.size,async read(at,length,{signal:sliceSignal}){
            await current(sliceSignal);
            if(!Number.isSafeInteger(at)||!Number.isSafeInteger(length)||at<0||length<1||length>65_536||at+length>snapshot.size)throw workspaceFailure('invalid_request','Invalid browser readback range');
            const bytes=new Uint8Array(await snapshot.slice(at,at+length).arrayBuffer());checkSignal(sliceSignal);return bytes;
          }});
        },
        async abort(){
          try{if(!finished)await writable.abort();}finally{finished=true;release();}
        },
        async close(){try{if(!finished)await writable.abort();}finally{finished=true;release();}},
      });
    }catch(error){try{if(writable)await writable.abort();}finally{release();}throw error;}
  }});
}

/** Uses exactly the caller-selected handle. Never opens a picker or requests permission. */
export function createBrowserFileSink(handle,options){exactObject(options,['overwrite']);return fileSink(handle,options,false);}

/** Uses one name under exactly the supplied origin-private directory; no ambient storage lookup. */
export async function createOpfsFileSink(directory,name,options){
  exactObject(options,['overwrite']);
  if(!directory||directory.kind!=='directory'||typeof directory.getFileHandle!=='function')throw workspaceFailure('unsupported','An explicitly selected OPFS directory handle is required');
  if(typeof name!=='string'||!name||name.length>128||!name.isWellFormed()||/[\\/:\u0000-\u001f\u007f]/u.test(name)||['.','..'].includes(name))throw workspaceFailure('unsafe_path','OPFS destination must be one file name');
  if(typeof options.overwrite!=='boolean')throw workspaceFailure('invalid_request','Explicit overwrite policy is required');
  // The platform does not expose an OPFS-origin brand. The caller must supply a handle
  // obtained from its chosen navigator.storage.getDirectory() subtree.
  const handle=await directory.getFileHandle(name,{create:true});return fileSink(handle,options,true);
}

export function getBrowserArtifactStorageSupport(){
  return Object.freeze({secureContext:globalThis.isSecureContext===true,filePicker:typeof globalThis.showSaveFilePicker==='function',originPrivate:typeof globalThis.navigator?.storage?.getDirectory==='function',writableStream:typeof globalThis.FileSystemFileHandle?.prototype?.createWritable==='function',syncAccess:typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle==='function'});
}
