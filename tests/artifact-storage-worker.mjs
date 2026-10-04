import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {createNodeJobStore} from '../src/job-storage-node.mjs';
import {createNodeArtifactStore} from '../src/artifact-storage-node.mjs';

const {mode,directory,workspaceRoot,workspaceId}=JSON.parse(process.argv[2]);
const jobStore=await createNodeJobStore({directory,workspaceRoot,workspaceId});
const artifacts=await createNodeArtifactStore({jobStore});
const bytes=Buffer.alloc(131079,37),hash=b=>createHash('sha256').update(b).digest('hex');
if(mode==='disk-full'){
  const open=fs.open;
  fs.open=async function(file,...args){
    const handle=await open.call(this,file,...args);
    if(String(file).includes('.capture-')){
      const write=handle.write.bind(handle);
      handle.write=async function(buffer,offset,length,position){
        if(position>=65536)throw Object.assign(new Error('Injected full disk'),{code:'ENOSPC'});
        return write(buffer,offset,length,position);
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
}
const source={path:'trace.bin',revision:hash(bytes),byteLength:bytes.length,async readChunk(offset,length){
  if(mode==='crash'&&offset>0){process.send({staged:true});await new Promise(()=>{});}
  const chunk=bytes.subarray(offset,offset+length);
  return{offset,nextOffset:offset+chunk.length,eof:offset+chunk.length===bytes.length,data:chunk.toString('base64'),sha256:hash(chunk)};
}};
try{
  await artifacts.capture({jobId:randomUUID(),pluginId:'example',pluginArtifactSha256:'a'.repeat(64),kind:'binary',artifact:{id:'trace',path:source.path,revision:source.revision,byteLength:source.byteLength}},source);
  throw new Error('Capture unexpectedly completed');
}catch(error){
  if(mode!=='disk-full'||error.code!=='budget_exceeded')throw error;
  process.send({code:error.code,files:artifacts.inspect().files,bytes:artifacts.inspect().bytes});
}finally{await artifacts.close();await jobStore.close();process.disconnect();}
