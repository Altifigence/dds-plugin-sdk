import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createToolRunner,hashToolFile} from '@altifigence/dds-plugin-sdk/tool-streams-node';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'dds-tool-example-')));
const fixture=fileURLToPath(new URL('./synthetic-tool.mjs',import.meta.url));
const flag=process.argv.indexOf('--typescript-root'),typescriptRoot=flag<0?null:process.argv[flag+1];
if(flag>=0&&(!typescriptRoot||!path.isAbsolute(typescriptRoot)))throw Error('Pass an absolute, operator-approved TypeScript 5.9.3 installation');
async function pinned(id,version,script,args,versionArgs,expectedVersionOutput,files=[]){return {id,version,approved:true,executable:process.execPath,executableSha256:await hashToolFile(process.execPath),files:await Promise.all([script,...files].map(async file=>({path:file,sha256:await hashToolFile(file)}))),args:[script,...args],versionArgs:[script,...versionArgs],expectedVersionOutput,environment:{}};}
const schema=properties=>({schemaVersion:1,schema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
let runner;
try{
  const registrations=[{process:await pinned('synthetic','1.0.0',fixture,[{input:'mode'}],['--version'],'DDS synthetic tool 1.0.0'),backendId:'analyze',inputSchema:schema({mode:{type:'string',enum:['normal','crash']}}),pathInputs:[],format:'jsonl',parser:'plain'}];
  if(typescriptRoot){
    const script=path.join(typescriptRoot,'bin','tsc');
    registrations.push({process:await pinned('typescript','5.9.3',script,['--noEmit','--noLib','--pretty','false',{input:'source'}],['--version'],'Version 5.9.3',[path.join(typescriptRoot,'lib','_tsc.js')]),backendId:'typecheck',inputSchema:schema({source:{type:'string',maxLength:180}}),pathInputs:['source'],format:'text',parser:'typescript'});
    await writeFile(path.join(root,'sample.ts'),'interface Array<T> {length:number; [n:number]:T} interface Boolean {} interface Function {} interface CallableFunction {} interface NewableFunction {} interface IArguments {} interface Number {} interface Object {} interface RegExp {} interface String {}\nconst count: number = "wrong";\n');
  }
  runner=createToolRunner({tools:registrations,workspaceRoot:root,authorize:()=>true,secrets:['mask-demo-value']});const events=[];
  const request={toolId:'synthetic',version:'1.0.0',input:{mode:'normal'},jobId:'example-job',commandId:'analyze',onEvent:event=>{events.push(event);}};
  const receipt=await runner.run(request);assert.equal(receipt.state,'succeeded');assert.equal(events.at(-1).data.message,'last partial line');assert.ok(events.some(e=>e.data.kind==='progress'));assert.ok(events.some(e=>e.data.message==='한글 output'));assert.ok(!JSON.stringify(events).includes('mask-demo-value'));assert.ok(!JSON.stringify(events).includes(root));
  const nonzero=await runner.run({...request,input:{mode:'crash'}});assert.equal(nonzero.exitCode,7);assert.equal(nonzero.state,'failed');
  let actualCompiler=null;
  if(typescriptRoot){events.length=0;const compiler=await runner.run({...request,toolId:'typescript',version:'5.9.3',commandId:'typecheck',input:{source:'sample.ts'}});assert.equal(compiler.reason,'NONZERO_EXIT');assert.ok(events.some(e=>e.data.kind==='diagnostic'&&e.data.code==='TS2322'&&e.data.path==='sample.ts'));actualCompiler={version:'5.9.3',diagnostic:'TS2322',zeroBased:true};}
  await runner.close();assert.deepEqual(runner.inspect(),{active:0,pending:0,closed:true});
  console.log(JSON.stringify({verified:true,fragmentedUtf8:true,trailingLine:true,redacted:true,nonzeroExit:7,actualCompiler,ownedProcessesClosed:true}));
}finally{await runner?.close();assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith('dds-tool-example-'));await rm(root,{recursive:true});}
