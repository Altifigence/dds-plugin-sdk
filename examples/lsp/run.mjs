import assert from 'node:assert/strict';
import {mkdtemp,realpath,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createLspBridge} from '@altifigence/dds-plugin-sdk/lsp-node';
import {hashToolFile} from '@altifigence/dds-plugin-sdk/tool-streams-node';
const root=await realpath(await mkdtemp(path.join(tmpdir(),'dds-lsp-example-'))),file=path.join(root,'sample.ts'),scope={projectId:'example',sessionId:'operator'};
const fixture=fileURLToPath(new URL('./synthetic-server.mjs',import.meta.url));
function argument(flag){const at=process.argv.indexOf(flag);if(at<0)return null;const value=process.argv[at+1];if(!value||!path.isAbsolute(value))throw Error('Pass an absolute, operator-approved installation for '+flag);return value;}
const tsRoot=argument('--typescript-root'),lsRoot=argument('--language-server-root');
if(!!tsRoot!==!!lsRoot)throw Error('The actual server example needs both --typescript-root and --language-server-root');
async function pinned(script,version,args,expectedVersionOutput,files=[]){return {id:'example-lsp',version,approved:true,executable:process.execPath,executableSha256:await hashToolFile(process.execPath),files:await Promise.all([script,...files].map(async file=>({path:file,sha256:await hashToolFile(file)}))),args:[script,...args],versionArgs:[script,'--version'],expectedVersionOutput,environment:{}};}
let bridge,counter=0;
const request=(snapshot,kind,extra={})=>({protocolVersion:1,requestId:'example-'+(++counter),scope,snapshot,kind,...(['document-symbols','document-symbol-tree','semantic-tokens','folding-ranges','inlay-hints','format-document','format-range','code-actions'].includes(kind)?{}:{position:{line:0,character:7}}),...extra});
try{
  const text='const value = 1;\nfunction add(a: number, b: number) {\n  return a + b;\n}\nadd(value, 2);\n';await writeFile(file,text);
  const snapshot={uri:pathToFileURL(file).href,languageId:'typescript',modelVersion:1,workspaceRevision:'example',text},diagnostics=[];
  bridge=await createLspBridge({process:await pinned(fixture,'1.0.0',['normal'],'DDS LSP fixture 1.0.0'),workspaceRoot:root,scope,authorize:()=>true,expectedServerName:'DDS LSP fixture',onDiagnostics:result=>{diagnostics.push(result);}});
  const span={start:{line:0,character:0},end:{line:4,character:14}},checks=[['completion',{}],['hover',{}],['definition',{}],['references',{includeDeclaration:true}],['document-symbols',{}],['signature-help',{}],['prepare-rename',{}],['rename',{newName:'renamed'}],['format-document',{path:'sample.ts',formatOptions:{tabSize:2,insertSpaces:true}}],['format-range',{path:'sample.ts',range:{start:{line:0,character:0},end:{line:0,character:16}},formatOptions:{tabSize:2,insertSpaces:true}}],['code-actions',{path:'sample.ts',range:span,diagnosticContext:{revision:1,diagnostics:[]}}],['semantic-tokens',{}],['folding-ranges',{}],['inlay-hints',{range:span}],['document-symbol-tree',{}]];
  for(const [kind,extra]of checks){const result=await bridge.request(request(snapshot,kind,extra));assert.equal(result.kind,kind);assert.notEqual(result.data,null);}
  assert.ok(diagnostics.length);assert.equal(await readFile(file,'utf8'),text);
  const syntheticClose=await bridge.close();bridge=null;assert.equal(syntheticClose.graceful,true);assert.equal(syntheticClose.ownedProcessClosed,true);
  let actualServer=null;
  if(tsRoot){
    const tsserver=path.join(tsRoot,'lib','tsserver.js'),typescript=path.join(tsRoot,'lib','typescript.js'),cli=path.join(lsRoot,'lib','cli.mjs');
    const actualText='export const sample = { alpha: 1, beta: "two" };\nexport function add(a: number, b: number) { return a + b; }\nconst total = add(sample.alpha, 2);\nsample.alpha;\n';await writeFile(file,actualText);
    const actual={...snapshot,text:actualText,modelVersion:2,workspaceRevision:'actual-server'};
    bridge=await createLspBridge({process:await pinned(cli,'5.3.0',['--stdio'],'5.3.0',[tsserver,typescript]),workspaceRoot:root,scope,authorize:()=>true,requestTimeoutMs:15000,initializationOptions:{hostInfo:'DDS Plugin SDK example',disableAutomaticTypingAcquisition:true,tsserver:{path:tsserver}}});
    const completion=await bridge.request(request(actual,'completion',{position:{line:3,character:7}}));assert.ok(completion.data.some(item=>item.label==='alpha'));
    const hover=await bridge.request(request(actual,'hover',{position:{line:2,character:26}}));assert.match(hover.data.text,/number/);
    const definition=await bridge.request(request(actual,'definition',{position:{line:2,character:26}}));assert.ok(definition.data.some(item=>item.path==='sample.ts'));
    const references=await bridge.request(request(actual,'references',{position:{line:0,character:14},includeDeclaration:true}));assert.ok(references.data.length>=2);
    const symbols=await bridge.request(request(actual,'document-symbols'));assert.ok(symbols.data.some(item=>item.name==='sample'));
    const signature=await bridge.request(request(actual,'signature-help',{position:{line:2,character:31}}));assert.ok(signature.data.signatures[0].label.includes('add'));
    await bridge.request(request(actual,'format-document',{path:'sample.ts',formatOptions:{tabSize:2,insertSpaces:true}}));
    const semantic=await bridge.request(request(actual,'semantic-tokens'));assert.ok(semantic.data.data.length>0);assert.equal(await readFile(file,'utf8'),actualText);
    const close=await bridge.close();bridge=null;assert.equal(close.ownedProcessClosed,true);assert.equal(close.pendingRequests,0);
    actualServer={serverVersion:'5.3.0',typescriptVersion:'5.9.3',verifiedFeatures:8,unversionedDiagnostics:'unsupported'};
  }
  console.log(JSON.stringify({verified:true,syntheticFeatures:15,versionedDiagnostics:true,filesUnchanged:true,actualServer,ownedProcessesClosed:true}));
}finally{await bridge?.close();assert.equal(path.dirname(root),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith('dds-lsp-example-'));await rm(root,{recursive:true});}
