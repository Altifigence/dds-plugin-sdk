import * as fs from 'node:fs/promises';
import path from 'node:path';
import {parseWorkspacePath} from './contracts.mjs';
import {parseDataSchema,validateDataValue} from './data-schema.mjs';
import {createToolStreamParser} from './tool-streams.mjs';
import {verifyTrustedProcess,parseTrustedProcessDefinition,hashToolFile,realToolWorkspace,checkToolWorkspace,spawnTrustedProcess,probeTrustedProcess} from './trusted-process-node.mjs';
import {canonical,clone,fail,fields,identifier,integer,immutable,jsonCopy,deadline,interruptible,authorized,errorCode} from './workflow-internals.mjs';

export {hashToolFile};
export const TOOL_RUNNER_LIMITS=Object.freeze({tools:32,concurrency:4,timeoutMs:600_000});
export function parseToolRegistration(input){
  const value=jsonCopy(input,131_072);fields(value,['process','backendId','inputSchema','pathInputs','format','parser']);parseTrustedProcessDefinition(value.process);identifier(value.backendId);
  const schema=parseDataSchema(value.inputSchema);if(schema.schema.type!=='object'||schema.schema.format)fail('INVALID','Tool input must be a closed object');
  if(!Array.isArray(value.pathInputs)||new Set(value.pathInputs).size!==value.pathInputs.length||value.pathInputs.length>64)fail('INVALID','Invalid path slots');
  for(const name of value.pathInputs){identifier(name);if(schema.schema.properties[name]?.type!=='string')fail('INVALID','Path input must be a declared string');}
  if(!['jsonl','text'].includes(value.format)||!['plain','typescript'].includes(value.parser))fail('INVALID','Tool parser not supported');
  for(const arg of value.process.args)if(typeof arg!=='string'){const property=schema.schema.properties[arg.input];if(!property||!['string','integer','number','boolean'].includes(property.type)||!schema.schema.required?.includes(arg.input))fail('INVALID','Argument input must be a required scalar');}
  return value;
}
async function inputPath(root,value){
  parseWorkspacePath(value);let candidate=root;
  for(const component of value.split('/')){candidate=path.join(candidate,component);const info=await fs.lstat(candidate);if(info.isSymbolicLink())fail('INVALID','Path input cannot traverse links');}
  const resolved=await fs.realpath(candidate),relative=path.relative(root,resolved);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!(await fs.lstat(candidate)).isFile())fail('INVALID','Path input must be a workspace file');
}
export function createToolRunner({tools,workspaceRoot,authorize,maxConcurrent=2,secrets=[],sensitivePaths=[]}={}){
  if(!Array.isArray(tools)||!tools.length||tools.length>32||typeof authorize!=='function')fail('INVALID','Operator registrations and authorization required');integer(maxConcurrent,1,4);
  const registrations=new Map(tools.map(t=>{const r=parseToolRegistration(t);return [r.process.id,r];}));if(registrations.size!==tools.length)fail('INVALID','Duplicate registered tool');
  const masks=jsonCopy({secrets,sensitivePaths}),active=new Set(),controllers=new Set(),completions=new Set();let pending=0,closed=false;
  return Object.freeze({
    inspect(){return {active:active.size,pending,closed};},
    async run({toolId,version,input,jobId,commandId,onEvent,signal,timeoutMs=60_000}={}){
      if(closed)fail('DISPOSED','Tool runner closed');if(pending>=maxConcurrent)fail('LIMIT','Tool concurrency limit');if(typeof onEvent!=='function')fail('INVALID','Event sink required');integer(timeoutMs,1,TOOL_RUNNER_LIMITS.timeoutMs);identifier(jobId);identifier(commandId);
      const registration=registrations.get(toolId);if(!registration||version!==registration.process.version)fail('UNSUPPORTED','Tool or version is not registered');
      const parsed=validateDataValue(registration.inputSchema,input),clock=deadline(signal,timeoutMs);let proc,parser,stats=null,state='failed',reason=null,exit={code:null,signal:null,error:null};pending++;
      controllers.add(clock.controller);let complete;const completed=new Promise(r=>{complete=r;});completions.add(completed);
      const context={toolId,version,backendId:registration.backendId,jobId,commandId,input:parsed};
      try{
        await authorized(authorize,{...context,phase:'before'},clock.signal);
        const workspace=await realToolWorkspace(workspaceRoot),verified=await interruptible(verifyTrustedProcess(registration.process),clock.signal);
        for(const name of registration.pathInputs)await inputPath(workspace.root,parsed[name]);
        const args=verified.definition.args.map(arg=>{if(typeof arg==='string')return arg;const value=String(parsed[arg.input]);if(value.startsWith('-')||value.includes('\0')||/[\r\n]/.test(value))fail('INVALID','Argument values cannot inject flags or lines');return value;});
        await probeTrustedProcess(verified.definition,workspace,clock.signal);await authorized(authorize,{...context,phase:'start'},clock.signal);await checkToolWorkspace(workspace);
        parser=createToolStreamParser({format:registration.format,parser:registration.parser,jobId,commandId,toolId,toolVersion:version,...masks,sensitivePaths:[...masks.sensitivePaths,workspace.root],signal:clock.signal,onEvent:async event=>{await authorized(authorize,{...context,phase:'event'},clock.signal);await onEvent(event);}});
        proc=spawnTrustedProcess(verified.definition,args,workspace,clock.signal);active.add(proc);proc.child.stdin.end();
        const consume=async(stream,name)=>{for await(const chunk of stream)await parser.write(chunk,name);};
        const reads=Promise.all([consume(proc.child.stdout,'stdout'),consume(proc.child.stderr,'stderr')]);
        [exit]=await interruptible(Promise.all([proc.finished,reads]),clock.signal);stats=await parser.finish();await authorized(authorize,{...context,phase:'after'},clock.signal);await checkToolWorkspace(workspace);
        state=exit.code===0&&!exit.error?'succeeded':'failed';reason=exit.error??(exit.code===0?null:'NONZERO_EXIT');
      }catch(error){reason=errorCode(error);state=reason==='CANCELLED'?'cancelled':reason==='TIMEOUT'?'timed_out':'failed';clock.controller.abort(error);}
      finally{parser?.dispose();try{if(proc)exit=await proc.stop();}finally{if(proc)active.delete(proc);clock.close();pending--;controllers.delete(clock.controller);complete();completions.delete(completed);}}
      return immutable({schemaVersion:1,toolId,toolVersion:version,jobId,commandId,state,reason,exitCode:exit.code,terminationSignal:exit.signal,stream:stats??parser?.inspect()??null});
    },
    async close(){closed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...completions]);},
  });
}
