import * as fs from 'node:fs/promises';
import path from 'node:path';
import {constants as flags} from 'node:fs';
import {UPLOAD_LIMITS} from './uploads.mjs';
import {validateUploadSourceRange} from './upload-transfer.mjs';
import {sameFileState,uploadRegular,uploadFileError} from './upload-files-node.mjs';
import {exactObject,workspaceFailure,WorkspaceError} from './workspace-values.mjs';
export async function createNodeUploadSource(configuration){
  exactObject(configuration,['path']);if(typeof configuration.path!=='string'||!path.isAbsolute(configuration.path))throw workspaceFailure('invalid_request','Select an absolute source file');
  try{
    const supplied=await fs.lstat(configuration.path,{bigint:true});uploadRegular(supplied,UPLOAD_LIMITS.fileBytes);const file=await fs.realpath(configuration.path),initial=await fs.lstat(file,{bigint:true});if(!sameFileState(initial,supplied))throw workspaceFailure('conflict','Selected upload source changed');
    const byteLength=Number(initial.size);
    return Object.freeze({byteLength,async read(offset,length,options={}){
      exactObject(options,[],['signal']);const {signal}=options;if(signal!==undefined&&!(signal instanceof AbortSignal))throw workspaceFailure('invalid_request','Expected AbortSignal');
      const check=()=>{if(signal?.aborted)throw signal.reason instanceof WorkspaceError?signal.reason:workspaceFailure('cancelled','Source read cancelled');};
      validateUploadSourceRange(byteLength,offset,length);check();let handle;
      try{
        const before=await fs.lstat(file,{bigint:true});uploadRegular(before,UPLOAD_LIMITS.fileBytes);if(!sameFileState(before,initial))throw workspaceFailure('conflict','Selected source changed');handle=await fs.open(file,flags.O_RDONLY|(flags.O_NOFOLLOW??0));
        if(!sameFileState(await handle.stat({bigint:true}),initial))throw workspaceFailure('conflict','Selected source changed');const bytes=Buffer.alloc(length);let at=0;
        while(at<length){check();const result=await handle.read(bytes,at,length-at,offset+at);if(!result.bytesRead)throw workspaceFailure('conflict','Selected source changed');at+=result.bytesRead;}
        const now=await fs.lstat(file,{bigint:true});uploadRegular(now,UPLOAD_LIMITS.fileBytes);if(!sameFileState(now,initial)||!sameFileState(await handle.stat({bigint:true}),initial))throw workspaceFailure('conflict','Selected source changed');check();return bytes;
      }catch(error){throw uploadFileError(error);}finally{await handle?.close();}
    }});
  }catch(error){throw uploadFileError(error);}
}
