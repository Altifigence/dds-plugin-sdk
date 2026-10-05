import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,realpath,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createPluginHost,definePlugin} from '../src/index.mjs';
import {createLspBridge,createLspFrameDecoder,encodeLspMessage,LSP_LIMITS} from '../src/lsp-node.mjs';
import {hashToolFile} from '../src/tool-streams-node.mjs';

const source='const value = 1;\nfunction add(a: number, b: number) {\n  return a + b;\n}\nadd(value, 2);\n';
const fixture=fileURLToPath(new URL('../examples/lsp/synthetic-server.mjs',import.meta.url));
const scope={projectId:'workspace',sessionId:'operator'},pos={line:0,character:7},span={start:{line:0,character:0},end:{line:4,character:14}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let counter=0;
const request=(snapshot,kind,extra={})=>({protocolVersion:1,requestId:'request-'+(++counter),scope,snapshot,kind,...(['document-symbols','document-symbol-tree','semantic-tokens','folding-ranges','inlay-hints','code-actions','format-document','format-range'].includes(kind)?{}:{position:pos}),...extra});
async function temporary(fn){const root=await realpath(await mkdtemp(path.join(tmpdir(),'dds-lsp-test-')));try{const file=path.join(root,'sample.ts');await writeFile(file,source);const snapshot={uri:pathToFileURL(file).href,languageId:'typescript',modelVersion:1,workspaceRevision:'initial',text:source};await fn(root,snapshot);}finally{assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith('dds-lsp-test-'));await rm(root,{recursive:true});}}
async function pinned(script,version,args,versionArgs,expectedVersionOutput,files=[]){return {id:'language-server',version,approved:true,executable:process.execPath,executableSha256:await hashToolFile(process.execPath),files:await Promise.all([script,...files].map(async file=>({path:file,sha256:await hashToolFile(file)}))),args:[script,...args],versionArgs:[script,...versionArgs],expectedVersionOutput,environment:{}};}
async function synthetic(root,mode='normal',extra={}){return createLspBridge({process:await pinned(fixture,'1.0.0',[mode],['--version'],'DDS LSP fixture 1.0.0'),workspaceRoot:root,scope,authorize:()=>true,expectedServerName:'DDS LSP fixture',requestTimeoutMs:2000,...extra});}

test('independent LSP framing respects byte lengths, fragmented UTF-8, batched frames, malformed/truncated headers and hard budgets',()=>{
  const message={jsonrpc:'2.0',id:1,result:{text:'한글😀'}},frame=encodeLspMessage(message),decoder=createLspFrameDecoder(),values=[];
  for(let i=0;i<frame.length;i+=2)values.push(...decoder.push(frame.subarray(i,i+2)));assert.deepEqual(values,[message]);decoder.finish();
  assert.equal(createLspFrameDecoder().push(Buffer.concat([frame,frame])).length,2);
  for(const text of ['Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}','Content-Length: -1\r\n\r\n{}','Content-Length: 999999999\r\n\r\n{}','Content-Length: 2\r\nContent-Type: application/vscode-jsonrpc; charset=utf-16\r\n\r\n{}'])assert.throws(()=>createLspFrameDecoder().push(Buffer.from(text)));
  const incomplete=createLspFrameDecoder();incomplete.push(frame.subarray(0,-1));assert.throws(()=>incomplete.finish());assert.throws(()=>createLspFrameDecoder().push(Buffer.alloc(65_537)));assert.equal(LSP_LIMITS.pendingRequests,16);
});

test('synthetic LSP maps every negotiated core and 0.11 feature to existing SDK contracts without applying edits or commands',async()=>temporary(async(root,snapshot)=>{
  const notifications=[],bridge=await synthetic(root,'normal',{onDiagnostics:d=>notifications.push(d)});
  try{
    const checks=[['completion',{}],['hover',{}],['definition',{}],['references',{includeDeclaration:true}],['document-symbols',{}],['signature-help',{}],['prepare-rename',{}],['rename',{newName:'renamed'}],['format-document',{path:'sample.ts',formatOptions:{tabSize:2,insertSpaces:true}}],['format-range',{path:'sample.ts',range:{start:{line:0,character:0},end:{line:0,character:16}},formatOptions:{tabSize:2,insertSpaces:true}}],['code-actions',{path:'sample.ts',range:span,diagnosticContext:{revision:1,diagnostics:[]}}],['semantic-tokens',{}],['folding-ranges',{}],['inlay-hints',{range:span}],['document-symbol-tree',{}]];
    for(const [kind,extra]of checks){const result=await bridge.request(request(snapshot,kind,extra));assert.equal(result.kind,kind);assert.notEqual(result.data,null,kind);if(kind==='code-actions'){assert.ok(result.data[0].edit);assert.match(result.data[1].disabled.reason,/unsupported/);}}
    assert.ok(notifications.length>=1);assert.equal(notifications[0].snapshot.modelVersion,1);assert.equal(await readFile(path.join(root,'sample.ts'),'utf8'),source);
    assert.equal(bridge.capabilities().features.filter(f=>f.supported).length,15);assert.ok(bridge.capabilities().unsupported.includes('server-commands'));
  }finally{const close=await bridge.close();assert.equal(close.graceful,true);assert.equal(close.ownedProcessClosed,true);assert.equal(close.pendingRequests,0);}
}));

test('LSP providers work inside the actual independent PluginHost registry',async()=>temporary(async(root,snapshot)=>{
  const bridge=await synthetic(root),host=createPluginHost({scope,grants:['document.read','language.provide']});
  try{
    const plugin=definePlugin({manifestVersion:2,id:'lsp-example',name:'LSP Example',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./run.mjs',runtime:'workspace',capabilities:['completion','hover','definition','references','document-symbols'],permissions:['document.read','language.provide'],supportedHosts:['test-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}},context=>{for(const kind of ['completion','hover','definition','references','document-symbols'])context.registerLanguageProvider(kind,{languages:['typescript']},bridge.provider(kind));});
    await host.activate(plugin);host.setDocument(snapshot);assert.equal((await host.requestLanguage('completion',{position:pos})).data[0].label,'value');assert.match((await host.requestLanguage('hover',{position:pos})).data.text,/number/);
  }finally{host.dispose();await bridge.close();}
}));

test('LSP initialize mismatches, unsupported features, URI escapes, invalid ranges and unversioned diagnostics are rejected explicitly',async()=>temporary(async(root,snapshot)=>{
  for(const mode of ['encoding','frame'])await assert.rejects(synthetic(root,mode));
  for(const [mode,kind,extra]of [['unsupported','hover',{}],['external','definition',{}],['outside-edit','rename',{newName:'newValue'}],['invalid-range','hover',{}]]){
    const bridge=await synthetic(root,mode);try{await assert.rejects(bridge.request(request(snapshot,kind,extra)));}finally{await bridge.close();}
  }
  const seen=[],bridge=await synthetic(root,'unversioned',{onDiagnostics:value=>seen.push(value)});try{await bridge.request(request(snapshot,'hover'));assert.equal(seen.length,0);assert.equal(bridge.inspect().unversionedDropped,1);}finally{await bridge.close();}
}));

test('LSP request cancellation, stale replies, duplicate IDs, revoked grants and crash/restart do not replay user operations',async()=>temporary(async(root,snapshot)=>{
  let allowed=true;const bridge=await synthetic(root,'late',{authorize:()=>allowed});
  try{
    const abort=new AbortController(),first=request(snapshot,'hover');const running=bridge.request(first,{signal:abort.signal});const rejected=assert.rejects(running,e=>e.code==='CANCELLED');await delay(20);await assert.rejects(bridge.request(first),e=>e.code==='CONFLICT');abort.abort();await rejected;await delay(120);assert.ok(bridge.inspect().transport.lateResponses>=1);
    const old=bridge.request(request(snapshot,'hover'));const stale=assert.rejects(old,e=>e.code==='STALE');await delay(15);await bridge.syncDocument({...snapshot,modelVersion:2,workspaceRevision:'new',text:source.replace('= 1','= 2')});await stale;
    allowed=false;await assert.rejects(bridge.request(request({...snapshot,modelVersion:2,workspaceRevision:'new',text:source.replace('= 1','= 2')},'hover')),e=>e.code==='DENIED');
  }finally{await bridge.close();}
  const crashed=await synthetic(root,'crash');await assert.rejects(crashed.request(request(snapshot,'hover')),e=>e.code==='SERVER_EXIT');assert.equal(crashed.inspect().transport.closed,true);await crashed.close();
  const restarted=await synthetic(root);try{assert.equal(restarted.inspect().documents,0);assert.match((await restarted.request(request(snapshot,'hover'))).data.text,/number/);}finally{await restarted.close();}
}));

test('LSP timeout, duplicate late response and refused shutdown release owned process and pending requests',async()=>temporary(async(root,snapshot)=>{
  let bridge=await synthetic(root,'timeout',{requestTimeoutMs:1000});try{await assert.rejects(bridge.request(request(snapshot,'hover')),e=>e.code==='TIMEOUT');}finally{await bridge.close();}
  bridge=await synthetic(root,'duplicate');await bridge.request(request(snapshot,'hover'));await delay(10);assert.ok(bridge.inspect().transport.lateResponses>=1);await bridge.close();
  bridge=await synthetic(root,'shutdown');const close=await bridge.close();assert.equal(close.graceful,false);assert.equal(close.ownedProcessClosed,true);assert.equal(close.pendingRequests,0);
}));

test('actual TypeScript language server 5.3.0 and TypeScript 5.9.3 interoperate through the published LSP subset',async()=>temporary(async(root)=>{
  const script=fileURLToPath(new URL('../node_modules/typescript-language-server/lib/cli.mjs',import.meta.url)),tsserver=fileURLToPath(new URL('../node_modules/typescript/lib/tsserver.js',import.meta.url)),typescript=fileURLToPath(new URL('../node_modules/typescript/lib/typescript.js',import.meta.url));
  const text='export const sample = { alpha: 1, beta: "two" };\nexport function add(a: number, b: number) { return a + b; }\nconst total = add(sample.alpha, 2);\nsample.alpha;\n';
  const file=path.join(root,'sample.ts');await writeFile(file,text);const snapshot={uri:pathToFileURL(file).href,languageId:'typescript',modelVersion:1,workspaceRevision:'typescript',text};
  // This release omits optional initialize.serverInfo; the exact file pins and --version probe identify it.
  const bridge=await createLspBridge({process:await pinned(script,'5.3.0',['--stdio'],['--version'],'5.3.0',[tsserver,typescript]),workspaceRoot:root,scope,authorize:()=>true,requestTimeoutMs:15_000,initializationOptions:{hostInfo:'DDS Plugin SDK example',disableAutomaticTypingAcquisition:true,tsserver:{path:tsserver}}});
  try{
    const completion=await bridge.request(request(snapshot,'completion',{position:{line:3,character:7}}));assert.ok(completion.data.some(item=>item.label==='alpha'));assert.ok(completion.data.some(item=>item.label==='beta'));
    const hover=await bridge.request(request(snapshot,'hover',{position:{line:2,character:26}}));assert.match(hover.data.text,/number/);
    const definition=await bridge.request(request(snapshot,'definition',{position:{line:2,character:26}}));assert.ok(definition.data.some(item=>item.path==='sample.ts'&&item.range.start.line===0));
    const references=await bridge.request(request(snapshot,'references',{position:{line:0,character:14},includeDeclaration:true}));assert.ok(references.data.length>=2);
    const symbols=await bridge.request(request(snapshot,'document-symbols'));assert.ok(symbols.data.some(item=>item.name==='sample'));
    const signature=await bridge.request(request(snapshot,'signature-help',{position:{line:2,character:31}}));assert.ok(signature.data.signatures[0].label.includes('add'));
    const format=await bridge.request(request(snapshot,'format-document',{path:'sample.ts',formatOptions:{tabSize:2,insertSpaces:true}}));assert.equal(format.kind,'format-document');
    const semantic=await bridge.request(request(snapshot,'semantic-tokens'));assert.ok(semantic.data.data.length>0);
    assert.equal(await readFile(file,'utf8'),text);
  }finally{const close=await bridge.close();assert.equal(close.ownedProcessClosed,true);assert.equal(close.pendingRequests,0);}
}));
