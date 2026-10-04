import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {performance} from 'node:perf_hooks';
// Instrument only this disposable child, before importing SDK modules. Count logical
// fs.promises payload I/O, not physical device traffic or operating-system cache misses.
const saved={},handles=new Set(),counts={readBytes:0,writeBytes:0,opens:0,peakHandles:0,renames:0};
const length=value=>typeof value==='string'?Buffer.byteLength(value):ArrayBuffer.isView(value)?value.byteLength:0;
function replace(name,wrapper){saved[name]=fs[name];fs[name]=wrapper(saved[name]);}
replace('readFile',original=>async(...args)=>{const value=await original(...args);counts.readBytes+=length(value);return value;});
replace('writeFile',original=>async(...args)=>{const result=await original(...args);counts.writeBytes+=length(args[1]);return result;});
replace('rename',original=>async(...args)=>{const result=await original(...args);counts.renames++;return result;});
replace('open',original=>async(...args)=>{
  const handle=await original(...args);handles.add(handle);counts.opens++;counts.peakHandles=Math.max(counts.peakHandles,handles.size);
  for(const name of ['readFile','writeFile','read','write','close']){
    const own=handle[name].bind(handle);handle[name]=async(...input)=>{
      const value=await own(...input);
      if(name==='readFile')counts.readBytes+=length(value);else if(name==='writeFile')counts.writeBytes+=length(input[0]);
      else if(name==='read')counts.readBytes+=value.bytesRead;else if(name==='write')counts.writeBytes+=value.bytesWritten;else if(name==='close')handles.delete(handle);
      return value;
    };
  }
  return handle;
});
syncBuiltinESMExports();
try{
  const began=performance.now(),{runCombinedWorkload}=await import('../examples/combined-workload/run.mjs'),importMs=performance.now()-began;
  const before={...counts},report=await runCombinedWorkload();
  if(handles.size)throw Error('Instrumented file handles were not closed');
  console.log(JSON.stringify({...report,importMs,logicalDisk:{readBytes:counts.readBytes-before.readBytes,writeBytes:counts.writeBytes-before.writeBytes,opens:counts.opens-before.opens,renames:counts.renames-before.renames,peakHandles:counts.peakHandles,remainingHandles:handles.size}}));
}finally{for(const [key,value] of Object.entries(saved))fs[key]=value;syncBuiltinESMExports();}
