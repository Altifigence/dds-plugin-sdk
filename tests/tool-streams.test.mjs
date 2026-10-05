import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createToolStreamParser,parseTypeScriptDiagnosticLine,createJobToolEventSink} from '../src/tool-streams.mjs';
import {createToolRunner,hashToolFile} from '../src/tool-streams-node.mjs';

const encode=text=>new TextEncoder().encode(text),delay=ms=>new Promise(r=>setTimeout(r,ms));
const context={jobId:'job-1',commandId:'build',toolId:'compiler',toolVersion:'1.0.0'};
const fixture=fileURLToPath(new URL('../examples/workflow-tools/synthetic-tool.mjs',import.meta.url));
const code=c=>e=>e.code===c;
async function temporary(fn){const root=await realpath(await mkdtemp(path.join(tmpdir(),'dds-tool-test-')));try{await fn(root);}finally{assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith('dds-tool-test-'));await rm(root,{recursive:true});}}
async function fixtureRegistration(){return {process:{id:'synthetic',version:'1.0.0',approved:true,executable:process.execPath,executableSha256:await hashToolFile(process.execPath),files:[{path:fixture,sha256:await hashToolFile(fixture)}],args:[fixture,{input:'mode'}],versionArgs:[fixture,'--version'],expectedVersionOutput:'DDS synthetic tool 1.0.0',environment:{}},backendId:'analyze',inputSchema:{schemaVersion:1,schema:{type:'object',properties:{mode:{type:'string',enum:['normal','slow','crash','long','flood']}},required:['mode'],additionalProperties:false}},pathInputs:[],format:'jsonl',parser:'plain'};}

test('portable stream parser preserves split UTF-8 and trailing output, validates diagnostics, redacts literal secrets across chunks, and awaits sinks',async()=>{
  const events=[];let sinks=0,peak=0;const parser=createToolStreamParser({...context,secrets:['mask-demo-value'],sensitivePaths:['/operator/private'],onEvent:async event=>{sinks++;peak=Math.max(peak,sinks);await delay(1);events.push(event);sinks--;}});
  const payload=encode(JSON.stringify({kind:'log',level:'info',message:'한글 mask-demo-value /operator/private'})+'\n'+JSON.stringify({kind:'progress',completed:1,total:2})+'\n'+JSON.stringify({kind:'diagnostic',path:'../outside',range:{},severity:'error',message:'bad'})+'\n'+JSON.stringify({kind:'log',level:'info',message:'trailer'}));
  for(let i=0;i<payload.length;i+=3)await parser.write(payload.subarray(i,i+3));
  const receipt=await parser.finish();assert.equal(peak,1);assert.equal(receipt.events,4);assert.equal(receipt.unknown,1);assert.equal(events[0].data.message,'한글 [redacted] [redacted]');assert.equal(events[3].data.message,'trailer');assert.equal(events[2].data.kind,'unknown');assert.equal(events[1].sequence,2);
});

test('tool parser rejects long lines, malformed UTF-8, byte/event/queue limits, cancellation and blocked sinks',async()=>{
  let parser=createToolStreamParser({...context,onEvent:()=>{}});await assert.rejects(parser.write(encode('x'.repeat(20_000))),code('LIMIT'));
  parser=createToolStreamParser({...context,onEvent:()=>{}});await assert.rejects(parser.write(Uint8Array.of(0xff)),code('INVALID'));
  parser=createToolStreamParser({...context,onEvent:()=>{},maxTotalBytes:5});assert.throws(()=>parser.write(encode('123456')),code('LIMIT'));
  parser=createToolStreamParser({...context,onEvent:()=>{},maxEvents:1});await assert.rejects(parser.write(encode('{"kind":"log","level":"info","message":"one"}\n{"kind":"log","level":"info","message":"two"}\n')),code('LIMIT'));
  parser=createToolStreamParser({...context,onEvent:()=>new Promise(()=>{}),eventTimeoutMs:5});await assert.rejects(parser.write(encode('{"kind":"log","level":"info","message":"one"}\n')),code('TIMEOUT'));
  const abort=new AbortController();parser=createToolStreamParser({...context,signal:abort.signal,onEvent:()=>{}});abort.abort();assert.throws(()=>parser.write(encode('x')),code('CANCELLED'));
  parser=createToolStreamParser({...context,onEvent:()=>{}});const pending=Array.from({length:8},()=>parser.write(encode('x')));assert.throws(()=>parser.write(encode('x')),code('LIMIT'));await Promise.all(pending);await parser.finish();
});

test('TypeScript diagnostic and JobReporter adapters preserve correlation and validated zero-based positions',async()=>{
  const parsed=parseTypeScriptDiagnosticLine('source.ts(2,8): error TS2322: Type mismatch');assert.equal(parsed.range.start.line,1);assert.equal(parsed.range.start.character,7);assert.equal(parsed.code,'TS2322');assert.throws(()=>parseTypeScriptDiagnosticLine('/outside/source.ts(1,1): error TS1: bad'));
  const progress=[],logs=[],diagnostics=[];const sink=createJobToolEventSink({reportProgress:p=>progress.push(p),log:(...l)=>logs.push(l)},{onDiagnostic:e=>diagnostics.push(e)});
  const parser=createToolStreamParser({...context,format:'text',parser:'typescript',onEvent:sink});await parser.write(encode('source.ts(2,8): error TS2322: Type mismatch\ncompiler note\n'));await parser.finish();assert.equal(diagnostics[0].jobId,'job-1');assert.equal(logs.length,1);
});

test('fixed registered Node tool emits output after exit and handles nonzero, flooding, cancellation, revocation, concurrency and unsupported versions',async()=>temporary(async root=>{
  const registration=await fixtureRegistration(),events=[];let allowed=true;
  const runner=createToolRunner({tools:[registration],workspaceRoot:root,maxConcurrent:1,authorize:()=>allowed,secrets:['mask-demo-value']});
  const invocation={toolId:'synthetic',version:'1.0.0',input:{mode:'normal'},jobId:'job',commandId:'analyze',onEvent:e=>events.push(e)};
  try{
    const ok=await runner.run(invocation);assert.equal(ok.state,'succeeded');assert.equal(ok.exitCode,0);assert.equal(events.at(-1).data.message,'last partial line');assert.ok(events.some(e=>e.data.message==='[redacted] [redacted]'));assert.ok(events.some(e=>e.data.message==='한글 output'));
    assert.equal((await runner.run({...invocation,input:{mode:'crash'}})).exitCode,7);
    assert.equal((await runner.run({...invocation,input:{mode:'long'}})).reason,'LIMIT');
    assert.equal((await runner.run({...invocation,input:{mode:'flood'}})).reason,'LIMIT');
    await assert.rejects(runner.run({...invocation,version:'2.0.0'}),code('UNSUPPORTED'));
    const abort=new AbortController();let entered;const ready=new Promise(r=>{entered=r;});
    const running=runner.run({...invocation,input:{mode:'slow'},signal:abort.signal,onEvent:()=>entered()});await ready;
    await assert.rejects(runner.run(invocation),code('LIMIT'));abort.abort();assert.equal((await running).state,'cancelled');assert.equal(runner.inspect().active,0);
    const denied=await runner.run({...invocation,onEvent:()=>{allowed=false;}});assert.equal(denied.state,'failed');assert.equal(denied.reason,'DENIED');
  }finally{await runner.close();}
}));

test('operator pins and exact version probes are enforced before registered tool invocation',async()=>temporary(async root=>{
  const registration=await fixtureRegistration();registration.process.files[0].sha256='0'.repeat(64);
  let runner=createToolRunner({tools:[registration],workspaceRoot:root,authorize:()=>true});
  const request={toolId:'synthetic',version:'1.0.0',input:{mode:'normal'},jobId:'j',commandId:'c',onEvent:()=>{}};
  assert.equal((await runner.run(request)).reason,'CONFLICT');await runner.close();
  registration.process.files[0].sha256=await hashToolFile(fixture);registration.process.expectedVersionOutput='different';runner=createToolRunner({tools:[registration],workspaceRoot:root,authorize:()=>true});assert.equal((await runner.run(request)).reason,'UNSUPPORTED');await runner.close();
}));

test('actual pinned TypeScript 5.9.3 compiler produces standard SDK diagnostics',async()=>temporary(async root=>{
  const tsc=fileURLToPath(new URL('../node_modules/typescript/bin/tsc',import.meta.url)),implementation=fileURLToPath(new URL('../node_modules/typescript/lib/_tsc.js',import.meta.url));
  await writeFile(path.join(root,'sample.ts'),'interface Array<T> {length:number; [n:number]:T} interface Boolean {} interface Function {} interface CallableFunction {} interface NewableFunction {} interface IArguments {} interface Number {} interface Object {} interface RegExp {} interface String {}\nconst count: number = "wrong";\n');
  const registration={process:{id:'typescript',version:'5.9.3',approved:true,executable:process.execPath,executableSha256:await hashToolFile(process.execPath),files:await Promise.all([tsc,implementation].map(async file=>({path:file,sha256:await hashToolFile(file)}))),args:[tsc,'--noEmit','--noLib','--pretty','false',{input:'source'}],versionArgs:[tsc,'--version'],expectedVersionOutput:'Version 5.9.3',environment:{}},backendId:'typecheck',inputSchema:{schemaVersion:1,schema:{type:'object',properties:{source:{type:'string',maxLength:180}},required:['source'],additionalProperties:false}},pathInputs:['source'],format:'text',parser:'typescript'};
  const runner=createToolRunner({tools:[registration],workspaceRoot:root,authorize:()=>true});const events=[];
  try{const receipt=await runner.run({toolId:'typescript',version:'5.9.3',input:{source:'sample.ts'},jobId:'compiler-job',commandId:'typecheck',onEvent:e=>events.push(e)});assert.equal(receipt.reason,'NONZERO_EXIT');assert.ok(events.some(e=>e.data.kind==='diagnostic'&&e.data.code==='TS2322'&&e.data.path==='sample.ts'),JSON.stringify(events));assert.ok(!JSON.stringify(events).includes(root));}
  finally{await runner.close();}
}));
