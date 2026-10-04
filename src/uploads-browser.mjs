import {UPLOAD_LIMITS,uploadInteger} from './uploads.mjs';
import {validateUploadSourceRange} from './upload-transfer.mjs';
import {exactObject,workspaceFailure,WorkspaceError} from './workspace-values.mjs';
/** A caller-selected File is immutable; no picker or permission prompt is opened. */
export function createBrowserUploadSource(file){
  if(typeof File==='undefined'||!(file instanceof File))throw workspaceFailure('invalid_request','Select a browser File');const byteLength=uploadInteger(file.size,UPLOAD_LIMITS.fileBytes);
  return Object.freeze({byteLength,async read(offset,length,options={}){
    exactObject(options,[],['signal']);const {signal}=options;if(signal!==undefined&&!(signal instanceof AbortSignal))throw workspaceFailure('invalid_request','Expected AbortSignal');validateUploadSourceRange(byteLength,offset,length);
    const check=()=>{if(signal?.aborted)throw signal.reason instanceof WorkspaceError?signal.reason:workspaceFailure('cancelled','Source read cancelled');};check();const bytes=new Uint8Array(await file.slice(offset,offset+length).arrayBuffer());check();if(bytes.length!==length)throw workspaceFailure('conflict','Selected File changed');return bytes;
  }});
}
