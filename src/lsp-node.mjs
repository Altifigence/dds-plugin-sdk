import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseScope,parseWorkspacePath,parseDocumentSnapshot,parseLanguageRequest,createLanguageResult,createDiagnosticsResult} from './contracts.mjs';
import {parseWorkspaceEdit,editHash} from './workspace-edit-contracts.mjs';
import {textIndex,compareLanguagePosition} from './language-values.mjs';
import {parseSemanticLegend} from './language-display.mjs';
import {CODE_ACTION_KINDS} from './language-editing.mjs';
import {verifyTrustedProcess,realToolWorkspace,checkToolWorkspace,spawnTrustedProcess,probeTrustedProcess} from './trusted-process-node.mjs';
import {createLspRpc,LSP_LIMITS} from './lsp-transport-node.mjs';
import {canonical,clone,digest,fail,fields,integer,immutable,jsonCopy,deadline,interruptible,authorized,errorCode} from './workflow-internals.mjs';

export {LSP_LIMITS,encodeLspMessage,createLspFrameDecoder} from './lsp-transport-node.mjs';
const mapping=[
  ['completion','textDocument/completion','completionProvider'],['hover','textDocument/hover','hoverProvider'],['definition','textDocument/definition','definitionProvider'],['references','textDocument/references','referencesProvider'],['document-symbols','textDocument/documentSymbol','documentSymbolProvider'],
  ['signature-help','textDocument/signatureHelp','signatureHelpProvider'],['prepare-rename','textDocument/prepareRename','renameProvider'],['rename','textDocument/rename','renameProvider'],['format-document','textDocument/formatting','documentFormattingProvider'],['format-range','textDocument/rangeFormatting','documentRangeFormattingProvider'],['code-actions','textDocument/codeAction','codeActionProvider'],['semantic-tokens','textDocument/semanticTokens/full','semanticTokensProvider'],['folding-ranges','textDocument/foldingRange','foldingRangeProvider'],['inlay-hints','textDocument/inlayHint','inlayHintProvider'],['document-symbol-tree','textDocument/documentSymbol','documentSymbolProvider'],
];
const unsupported=['completion-resolve','completion-snippets','code-action-resolve','semantic-tokens-delta','server-commands','dynamic-capabilities','resource-operations','sockets','unversioned-diagnostics'];
export function lspCapabilityMatrix(input){
  const capabilities=jsonCopy(input,65_536);if(!capabilities||typeof capabilities!=='object'||Array.isArray(capabilities))fail('INVALID','Invalid server capabilities');
  if(capabilities.positionEncoding!==undefined&&capabilities.positionEncoding!=='utf-16')fail('UNSUPPORTED','Only negotiated UTF-16 positions are supported');
  const features=mapping.map(([sdkFeature,method,cap])=>{
    const provided=capabilities[cap];let supported=provided===true||!!provided&&typeof provided==='object'&&!Array.isArray(provided);
    if(sdkFeature==='prepare-rename')supported=!!provided?.prepareProvider;
    if(sdkFeature==='semantic-tokens')supported=!!provided?.full&&!!provided?.legend;
    return {sdkFeature,method,supported,reason:supported?'advertised':'not-advertised'};
  });
  return immutable({schemaVersion:1,protocol:'3.17',transport:'stdio',positionEncoding:'utf-16',features,unsupported:[...unsupported]});
}
export function parseLspCapabilityMatrix(input){
  const value=jsonCopy(input,16_384);fields(value,['schemaVersion','protocol','transport','positionEncoding','features','unsupported']);
  if(value.schemaVersion!==1||value.protocol!=='3.17'||value.transport!=='stdio'||value.positionEncoding!=='utf-16'||!Array.isArray(value.features)||value.features.length!==mapping.length||canonical(value.unsupported)!==canonical(unsupported))fail('INVALID','Unsupported capability matrix');
  for(let i=0;i<mapping.length;i++){const f=value.features[i];fields(f,['sdkFeature','method','supported','reason']);if(f.sdkFeature!==mapping[i][0]||f.method!==mapping[i][1]||typeof f.supported!=='boolean'||f.reason!==(f.supported?'advertised':'not-advertised'))fail('INVALID','Capability matrix mismatch');}
  return value;
}
const limitList=(value,max=500)=>{if(!Array.isArray(value)||value.length>max)fail('LIMIT','LSP result item limit');return value;};
const object=value=>{if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID','Expected LSP object');return value;};
const string=(value,max=16_384)=>{if(typeof value!=='string'||!value.isWellFormed()||value.length>max)fail('INVALID','Invalid LSP text');return value;};
const scalarText=value=>typeof value==='string'?value:value&&typeof value==='object'&&typeof value.value==='string'?value.value:fail('INVALID','Unsupported LSP markup');
const markup=value=>value===undefined?'':Array.isArray(value)?limitList(value,16).map(scalarText).join('\n'):scalarText(value);
const symbolKind={1:'module',2:'module',3:'namespace',4:'module',5:'class',6:'method',7:'property',8:'property',9:'method',10:'type',11:'interface',12:'function',13:'variable',14:'constant',15:'variable',16:'variable',17:'variable',18:'variable',19:'property',20:'property',21:'constant',22:'type',23:'type',24:'type',25:'variable',26:'type'};
const severity={1:'error',2:'warning',3:'info',4:'hint'};
const clientCapabilities={general:{positionEncodings:['utf-16'],staleRequestSupport:{cancel:true,retryOnContentModified:[]}},workspace:{applyEdit:false,configuration:true,workspaceFolders:false,workspaceEdit:{documentChanges:true,resourceOperations:[],failureHandling:'abort',normalizesLineEndings:false}},textDocument:{synchronization:{dynamicRegistration:false,didSave:false,willSave:false},completion:{dynamicRegistration:false,completionItem:{snippetSupport:false,commitCharactersSupport:false,documentationFormat:['plaintext'],deprecatedSupport:false,preselectSupport:false,insertReplaceSupport:false}},hover:{dynamicRegistration:false,contentFormat:['plaintext']},definition:{dynamicRegistration:false,linkSupport:true},references:{dynamicRegistration:false},documentSymbol:{dynamicRegistration:false,hierarchicalDocumentSymbolSupport:true},signatureHelp:{dynamicRegistration:false,signatureInformation:{documentationFormat:['plaintext'],parameterInformation:{labelOffsetSupport:true},activeParameterSupport:true},contextSupport:true},rename:{dynamicRegistration:false,prepareSupport:true},formatting:{dynamicRegistration:false},rangeFormatting:{dynamicRegistration:false},codeAction:{dynamicRegistration:false,codeActionLiteralSupport:{codeActionKind:{valueSet:CODE_ACTION_KINDS}},disabledSupport:true,isPreferredSupport:true,dataSupport:false},publishDiagnostics:{relatedInformation:false,versionSupport:true},semanticTokens:{dynamicRegistration:false,requests:{range:false,full:true},tokenTypes:['namespace','type','class','enum','interface','struct','typeParameter','parameter','variable','property','enumMember','event','function','method','macro','keyword','modifier','comment','string','number','regexp','operator','decorator'],tokenModifiers:['declaration','definition','readonly','static','deprecated','abstract','async','modification','documentation','defaultLibrary'],formats:['relative'],overlappingTokenSupport:false,multilineTokenSupport:false},foldingRange:{dynamicRegistration:false,rangeLimit:1000,lineFoldingOnly:false},inlayHint:{dynamicRegistration:false}},window:{workDoneProgress:false}};

/** Explicitly approved stdio server. Every file read/edit result remains host-authorized and data-only. */
export async function createLspBridge({process:processDefinition,workspaceRoot,scope,authorize,onDiagnostics=async()=>{},readDocument,configuration={},initializationOptions={},expectedServerName,requestTimeoutMs=5000,signal,secrets=[]}={}){
  scope=parseScope(scope);if(typeof authorize!=='function'||typeof onDiagnostics!=='function'||readDocument!==undefined&&typeof readDocument!=='function')fail('INVALID','LSP owner ports required');integer(requestTimeoutMs,1,LSP_LIMITS.timeoutMs);
  configuration=jsonCopy(configuration,65_536);initializationOptions=jsonCopy(initializationOptions,65_536);
  const lifetime=new AbortController(),abort=()=>lifetime.abort();
  const documents=new Map(),requests=new Map(),metrics={diagnostics:0,unversionedDropped:0,staleDropped:0,rejectedNotifications:0,ignoredNotifications:0};
  let proc,rpc,workspace,server,matrix,legend=null,state='initializing',generation=0,docTail=Promise.resolve(),closePromise;
  if(!Array.isArray(secrets)||secrets.length>32)fail('INVALID','Invalid LSP masks');const masks=secrets.map(v=>{string(v,4096);if(!v)fail('INVALID','Empty mask');return v;});
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const redact=text=>[...masks,workspace?.root??''].filter(Boolean).reduce((value,mask)=>value.split(mask).join('[redacted]'),text);
  const clean=(v,max=16_384)=>redact(string(v,max));
  const access=(operation,file,requestSignal=lifetime.signal)=>authorized(authorize,{operation,scope,path:file??null,serverId:server?.definition.id??processDefinition?.id,serverVersion:server?.definition.version??processDefinition?.version},requestSignal);
  async function localUri(uri){
    const url=new URL(string(uri,2048));if(url.protocol!=='file:'||url.host||url.username||url.password||url.search||url.hash)fail('DENIED','Only local workspace file URIs are supported');
    const absolute=fileURLToPath(url),relative=path.relative(workspace.root,absolute);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))fail('DENIED','URI outside workspace');
    const name=parseWorkspacePath(relative.split(path.sep).join('/'));await checkToolWorkspace(workspace);
    let current=workspace.root,canonicalFile;const parts=name.split('/');
    for(let i=0;i<parts.length;i++){current=path.join(current,parts[i]);try{const stat=await fs.lstat(current);if(stat.isSymbolicLink()||i<parts.length-1&&!stat.isDirectory()||i===parts.length-1&&!stat.isFile())fail('DENIED','URI is not a regular workspace file');}catch(e){if(e.code==='ENOENT'&&i===parts.length-1)break;throw e;}}
    try{canonicalFile=await fs.realpath(current);}catch(e){if(e.code!=='ENOENT')throw e;canonicalFile=current;}
    const canonicalRelative=path.relative(workspace.root,canonicalFile);if(canonicalRelative==='..'||canonicalRelative.startsWith('..'+path.sep)||path.isAbsolute(canonicalRelative))fail('DENIED','Resolved URI outside workspace');
    return {path:parseWorkspacePath(canonicalRelative.split(path.sep).join('/')),uri:pathToFileURL(canonicalFile).href};
  }
  async function documentFor(uri,operation,requestSignal){
    const local=await localUri(uri);await access(operation,local.path,requestSignal);let document=documents.get(local.uri);
    if(!document&&readDocument){const snapshot=parseDocumentSnapshot(await interruptible(Promise.resolve().then(()=>readDocument(local.path,{signal:requestSignal})),requestSignal));if((await localUri(snapshot.uri)).uri!==local.uri)fail('CONFLICT','Document port returned another URI');document={path:local.path,snapshot};}
    if(!document)fail('UNSUPPORTED','Open the target document or provide an authorized readDocument port');return document;
  }
  const invalidate=()=>{generation++;for(const c of requests.values())c.abort();};
  const serial=action=>{const p=docTail.then(action);docTail=p.catch(()=>{});return p;};
  const open=()=>{if(state!=='ready'||rpc.inspect().closed)fail('DISPOSED','LSP bridge is not ready');};
  function current(snapshot,epoch){const doc=documents.get(snapshot.uri);if(epoch!==generation||!doc||canonical(doc.snapshot)!==canonical(snapshot))fail('STALE','Document changed while the server was working');}
  async function diagnostics(params){
    try{
      object(params);const local=await localUri(params.uri),doc=documents.get(local.uri);
      if(!doc){metrics.staleDropped++;return;}
      if(params.version===undefined){metrics.unversionedDropped++;return;}
      if(params.version!==doc.snapshot.modelVersion){metrics.staleDropped++;return;}
      const epoch=generation,clock=deadline(lifetime.signal,requestTimeoutMs);
      try{
        await access('diagnostics',local.path,clock.signal);const index=textIndex(doc.snapshot.text);
        const values=limitList(params.diagnostics).map(d=>{object(d);index.range(d.range);if(d.severity!==undefined&&!severity[d.severity])fail('INVALID','Invalid diagnostic severity');return {range:d.range,severity:severity[d.severity??1],message:clean(d.message),...(d.code!==undefined?{code:clean(String(d.code),128)}:{}),...(d.source!==undefined?{source:clean(d.source,128)}:{})};});
        current(doc.snapshot,epoch);const result=createDiagnosticsResult({protocolVersion:1,requestId:randomUUID(),scope,snapshot:doc.snapshot},values);
        await interruptible(Promise.resolve().then(()=>onDiagnostics(result)),clock.signal);metrics.diagnostics++;
      }finally{clock.close();}
    }catch{metrics.rejectedNotifications++;}
  }
  async function serverRequest(method,params){
    if(method==='workspace/applyEdit')return {applied:false,failureReason:'Use an explicitly reviewed SDK workspace edit proposal'};
    if(method==='window/showMessageRequest')return null;
    if(method==='workspace/configuration'){
      object(params);const clock=deadline(lifetime.signal,requestTimeoutMs);
      try{const result=[];for(const item of limitList(params.items,32)){object(item);if(item.scopeUri){const local=await localUri(item.scopeUri);await access('read',local.path,clock.signal);}const section=string(item.section??'',128);result.push(Object.hasOwn(configuration,section)?configuration[section]:null);}return result;}finally{clock.close();}
    }
    fail('UNSUPPORTED','Server request not supported');
  }
  try{
    const clock=deadline(lifetime.signal,Math.max(requestTimeoutMs,10_000));
    try{
      await access('start',null,clock.signal);workspace=await realToolWorkspace(workspaceRoot);server=await interruptible(verifyTrustedProcess(processDefinition),clock.signal);
      if(server.definition.args.some(arg=>typeof arg!=='string'))fail('INVALID','LSP arguments must be operator-fixed');
      await probeTrustedProcess(server.definition,workspace,clock.signal);await access('start',null,clock.signal);
      proc=spawnTrustedProcess(server.definition,server.definition.args,workspace,lifetime.signal);
      rpc=createLspRpc(proc,{signal:lifetime.signal,timeoutMs:requestTimeoutMs,onNotification:async(method,params)=>{if(method==='textDocument/publishDiagnostics')await diagnostics(params);else metrics.ignoredNotifications++;},onRequest:serverRequest});
      const initialized=await rpc.request('initialize',{processId:null,clientInfo:{name:'DDS public Plugin SDK',version:'1.2'},rootUri:pathToFileURL(workspace.root+path.sep).href,capabilities:clientCapabilities,initializationOptions,workspaceFolders:null},{signal:clock.signal,timeoutMs:Math.max(requestTimeoutMs,10_000)});
      object(initialized);object(initialized.capabilities);
      if(expectedServerName!==undefined&&initialized.serverInfo?.name!==expectedServerName)fail('UNSUPPORTED','Unexpected language server identity');
      if(initialized.serverInfo?.version!==undefined&&initialized.serverInfo.version!==server.definition.version)fail('UNSUPPORTED','Language server version disagrees with its pin');
      matrix=lspCapabilityMatrix(initialized.capabilities);
      const sync=initialized.capabilities.textDocumentSync,change=typeof sync==='number'?sync:sync?.change;
      if(![1,2].includes(change)||typeof sync==='object'&&sync.openClose===false)fail('UNSUPPORTED','Server lacks supported document synchronization');
      if(matrix.features.find(f=>f.sdkFeature==='semantic-tokens').supported){
        const raw=initialized.capabilities.semanticTokensProvider.legend;
        const style=name=>['namespace','type','class','enum','interface','struct','typeParameter'].includes(name)?'type':['function','method'].includes(name)?'function':['variable','parameter','property','enumMember'].includes(name)?'variable':['keyword','comment','string','number','operator'].includes(name)?name:'plain';
        legend=parseSemanticLegend({tokenTypes:limitList(raw.tokenTypes,64).map(name=>({name,style:style(name)})),tokenModifiers:limitList(raw.tokenModifiers,16)});
      }
      await rpc.notify('initialized',{});state='ready';
    }finally{clock.close();}
  }catch(error){state='closed';lifetime.abort();signal?.removeEventListener('abort',abort);await rpc?.close();await proc?.stop();throw error;}

  async function edits(value,title,requestSignal){
    if(value===null)return null;object(value);if(value.changeAnnotations!==undefined)fail('UNSUPPORTED','Edit annotations are not supported');
    let changes;
    if(value.documentChanges!==undefined)changes=limitList(value.documentChanges,32).map(c=>{object(c);if(c.kind!==undefined||!c.textDocument)fail('UNSUPPORTED','LSP file operations are not supported');return {uri:c.textDocument.uri,version:c.textDocument.version,edits:c.edits};});
    else if(value.changes!==undefined)changes=Object.entries(object(value.changes)).map(([uri,items])=>({uri,version:null,edits:items}));
    else fail('INVALID','Missing LSP edit changes');
    if(changes.length>32)fail('LIMIT','Workspace edit file count');const result=[];
    for(const c of changes){
      const doc=await documentFor(c.uri,'edit',requestSignal);if(c.version!==null&&c.version!==undefined&&c.version!==doc.snapshot.modelVersion)fail('STALE','Workspace edit version changed');
      const index=textIndex(doc.snapshot.text),items=limitList(c.edits,500).map(e=>{fields(e,['range','newText']);index.range(e.range);return {range:e.range,text:string(e.newText,262_144)};});
      if(items.length)result.push({kind:'edit',path:doc.path,baseRevision:editHash(doc.snapshot.text),edits:items});
    }
    return result.length?parseWorkspaceEdit({formatVersion:1,id:randomUUID(),title,changes:result}):null;
  }
  function symbols(raw,snapshot,tree){
    const index=textIndex(snapshot.text);let count=0;
    const visit=(values,depth)=>{if(depth>16)fail('LIMIT','Symbol depth');return limitList(values,1000).map(value=>{
      if(++count>1000)fail('LIMIT','Symbol count');object(value);const range=value.range??value.location?.range;if(value.location&&value.location.uri!==snapshot.uri)fail('DENIED','Document symbol belongs to another URI');
      index.range(range);const selectionRange=value.selectionRange??range;index.range(selectionRange);if(!symbolKind[value.kind])fail('INVALID','Unknown symbol kind');
      return {name:clean(value.name,256),kind:symbolKind[value.kind],range,selectionRange,...(value.detail?{detail:clean(value.detail,2048)}:{}),...(value.children?{children:visit(value.children,depth+1)}:{})};
    }).sort((a,b)=>compareLanguagePosition(a.range.start,b.range.start)||compareLanguagePosition(b.range.end,a.range.end));};
    const values=visit(raw??[],0);if(tree)return values;const flat=[];const flatten=items=>{for(const value of items){const {children,...item}=value;flat.push(item);if(children)flatten(children);}};flatten(values);return flat;
  }
  async function transform(request,raw,requestSignal){
    const kind=request.kind,doc=documents.get(request.snapshot.uri),index=textIndex(request.snapshot.text);
    if(kind==='completion'){
      if(raw===null)return [];const list=Array.isArray(raw)?raw:object(raw).items;if(!Array.isArray(raw)&&raw.itemDefaults!==undefined)fail('UNSUPPORTED','Completion list defaults are not supported');
      return limitList(list).map(value=>{
        object(value);if(value.command||value.insertTextFormat===2)fail('UNSUPPORTED','Completion commands and snippets are not supported');
        const edit=value.textEdit;if(edit&&(edit.insert||edit.replace))fail('UNSUPPORTED','Insert/replace completion edits are not supported');
        if(edit)index.range(edit.range);
        const result={label:clean(value.label,256),insertText:string(edit?.newText??value.insertText??value.label),...(edit?{range:edit.range}:{}),...(value.detail?{detail:clean(value.detail,2048)}:{}),...(value.documentation?{documentation:clean(markup(value.documentation))}:{})};
        if(value.additionalTextEdits)result.additionalTextEdits=limitList(value.additionalTextEdits,32).map(e=>{fields(e,['range','newText']);index.range(e.range);return {range:e.range,text:string(e.newText)};});return result;
      });
    }
    if(kind==='hover'){if(raw===null)return null;object(raw);if(raw.range)index.range(raw.range);const text=clean(markup(raw.contents));return text?{text,...(raw.range?{range:raw.range}:{})}:null;}
    if(kind==='definition'||kind==='references'){
      const result=[];for(const value of limitList(raw===null?[]:Array.isArray(raw)?raw:[raw])){object(value);const target=await documentFor(value.targetUri??value.uri,'read',requestSignal),range=value.targetSelectionRange??value.range;textIndex(target.snapshot.text).range(range);result.push({path:target.path,range});}return result;
    }
    if(kind==='document-symbols'||kind==='document-symbol-tree')return symbols(raw,request.snapshot,kind==='document-symbol-tree');
    if(kind==='signature-help'){
      if(raw===null)return null;object(raw);const signatures=limitList(raw.signatures,16).map(value=>{object(value);const label=clean(value.label,2048);let after=0;return {label,...(value.documentation?{documentation:clean(markup(value.documentation))}:{}),parameters:limitList(value.parameters??[],64).map(p=>{object(p);let range=p.label;if(typeof range==='string'){const start=label.indexOf(range,after);if(start<0)fail('INVALID','Parameter is not in the signature label');range=[start,start+range.length];after=range[1];}return {label:range,...(p.documentation?{documentation:clean(markup(p.documentation))}:{})};})};});
      if(!signatures.length)return null;const activeSignature=raw.activeSignature??0,selected=signatures[activeSignature];if(!selected)fail('INVALID','Signature index outside result');const parameter=raw.signatures[activeSignature]?.activeParameter??raw.activeParameter??null;
      return {signatures,activeSignature,activeParameter:parameter!==null&&parameter<selected.parameters.length?parameter:null};
    }
    if(kind==='prepare-rename'){
      if(raw===null)return null;object(raw);if(raw.defaultBehavior!==undefined)fail('UNSUPPORTED','Default rename behavior unsupported');const range=raw.range??raw,indexed=index.range(range);return {range,placeholder:clean(raw.placeholder??request.snapshot.text.slice(indexed.start,indexed.end),256)};
    }
    if(kind==='rename')return edits(raw,'LSP rename proposal',requestSignal);
    if(kind==='format-document'||kind==='format-range')return raw===null?null:edits({changes:{[request.snapshot.uri]:raw}},'LSP formatting proposal',requestSignal);
    if(kind==='code-actions'){
      const result=[];for(const action of limitList(raw??[],100)){
        object(action);const kind=[...CODE_ACTION_KINDS].sort((a,b)=>b.length-a.length).find(k=>action.kind===k||action.kind?.startsWith(k+'.'))??'quickfix';const base={title:clean(action.title,256),kind,...(action.isPreferred!==undefined?{isPreferred:action.isPreferred}:{})};
        if(action.disabled){result.push({...base,disabled:{reason:clean(action.disabled.reason,2048)}});continue;}
        if(action.command||!action.edit){result.push({...base,disabled:{reason:action.command?'Server command execution is unsupported':'Code action resolution is unsupported'}});continue;}
        const edit=await edits(action.edit,'LSP code action proposal',requestSignal);if(edit)result.push({...base,edit});
      }return result;
    }
    if(kind==='semantic-tokens'){if(raw!==null)object(raw);const data=raw?.data??[];return {resultId:raw?.resultId??digest(canonical(data)),legend,data,updateKind:'full'};}
    if(kind==='folding-ranges'){
      const lines=request.snapshot.text.split(/\r\n|\r|\n/);return limitList(raw??[],1000).map(f=>{object(f);const range={start:{line:f.startLine,character:f.startCharacter??0},end:{line:f.endLine,character:f.endCharacter??lines[f.endLine]?.length}};index.range(range);return {range,...(f.kind?{kind:f.kind}:{}),...(f.collapsedText?{collapsedText:clean(f.collapsedText,256)}:{})};}).sort((a,b)=>compareLanguagePosition(a.range.start,b.range.start)||compareLanguagePosition(b.range.end,a.range.end));
    }
    if(kind==='inlay-hints')return limitList(raw??[],1000).map(h=>{object(h);index.offset(h.position);const label=typeof h.label==='string'?h.label:limitList(h.label,32).map(p=>string(p.value,1024)).join('');return {position:h.position,label:clean(label,1024),...(h.kind===1?{kind:'type'}:h.kind===2?{kind:'parameter'}:{}),...(h.paddingLeft!==undefined?{paddingLeft:h.paddingLeft}:{}),...(h.paddingRight!==undefined?{paddingRight:h.paddingRight}:{}),...(h.tooltip?{tooltip:clean(markup(h.tooltip),4096)}:{})};}).sort((a,b)=>compareLanguagePosition(a.position,b.position));
    fail('UNSUPPORTED','Language feature is not mapped');
  }
  const api={
    capabilities(){return matrix;},
    inspect(){return {state,generation,documents:documents.size,requests:requests.size,...metrics,transport:rpc.inspect(),process:proc.inspect()};},
    syncDocument(input){
      const snapshot=parseDocumentSnapshot(input);return serial(async()=>{
        open();const clock=deadline(lifetime.signal,requestTimeoutMs);
        try{
          const local=await localUri(snapshot.uri);if(local.uri!==snapshot.uri)fail('INVALID','Document URI must be canonical');await access('read',local.path,clock.signal);
          const old=documents.get(local.uri);if(old&&canonical(old.snapshot)===canonical(snapshot))return snapshot;
          if(old&&(snapshot.modelVersion<old.snapshot.modelVersion||snapshot.modelVersion===old.snapshot.modelVersion&&snapshot.text!==old.snapshot.text))fail('STALE','Document version did not advance');
          if(!old&&documents.size>=LSP_LIMITS.documents)fail('LIMIT','Open document count');
          const total=[...documents.values()].reduce((n,d)=>n+Buffer.byteLength(d.snapshot.text),0)-(old?Buffer.byteLength(old.snapshot.text):0)+Buffer.byteLength(snapshot.text);if(total>LSP_LIMITS.documentBytes)fail('LIMIT','Open document byte budget');
          invalidate();documents.set(local.uri,{path:local.path,snapshot});
          if(!old)await rpc.notify('textDocument/didOpen',{textDocument:{uri:local.uri,languageId:snapshot.languageId,version:snapshot.modelVersion,text:snapshot.text}});
          else if(snapshot.modelVersion!==old.snapshot.modelVersion)await rpc.notify('textDocument/didChange',{textDocument:{uri:local.uri,version:snapshot.modelVersion},contentChanges:[{text:snapshot.text}]});
          return snapshot;
        }finally{clock.close();}
      });
    },
    closeDocument(uri){return serial(async()=>{open();const local=await localUri(uri);if(!documents.has(local.uri))return;invalidate();documents.delete(local.uri);await rpc.notify('textDocument/didClose',{textDocument:{uri:local.uri}});});},
    async request(input,{signal:callerSignal}={}){
      open();const request=parseLanguageRequest(input);if(canonical(request.scope)!==canonical(scope))fail('DENIED','Language request scope differs');
      const feature=matrix.features.find(f=>f.sdkFeature===request.kind);if(!feature?.supported)fail('UNSUPPORTED','Language feature was not negotiated');
      if(requests.has(request.requestId))fail('CONFLICT','Duplicate active SDK request ID');if(requests.size>=16)fail('LIMIT','Bridge request concurrency');
      await api.syncDocument(request.snapshot);const doc=documents.get(request.snapshot.uri);if(request.path!==undefined&&request.path!==doc.path)fail('DENIED','Request path differs from document URI');
      // Recheck after synchronization because concurrent callers can share a request ID.
      if(requests.has(request.requestId))fail('CONFLICT','Duplicate active SDK request ID');
      const epoch=generation,controller=new AbortController(),cancel=()=>controller.abort();callerSignal?.addEventListener('abort',cancel,{once:true});if(callerSignal?.aborted)cancel();requests.set(request.requestId,controller);
      const clock=deadline(controller.signal,requestTimeoutMs);
      try{
        await access('read',doc.path,clock.signal);current(request.snapshot,epoch);
        const params={textDocument:{uri:request.snapshot.uri},...(request.position?{position:request.position}:{})};
        if(request.kind==='references')params.context={includeDeclaration:request.includeDeclaration??false};
        if(request.kind==='completion'&&request.context)params.context={triggerKind:{invoked:1,character:2,incomplete:3}[request.context.triggerKind],...(request.context.triggerCharacter?{triggerCharacter:request.context.triggerCharacter}:{})};
        if(request.kind==='signature-help'&&request.context)params.context={triggerKind:{invoked:1,character:2,'content-change':3}[request.context.triggerKind],isRetrigger:request.context.isRetrigger,...(request.context.triggerCharacter?{triggerCharacter:request.context.triggerCharacter}:{})};
        if(request.kind==='rename')params.newName=request.newName;
        if(request.range)params.range=request.range;
        if(request.formatOptions){const {endOfLine,...options}=request.formatOptions;params.options=options;}
        if(request.kind==='code-actions')params.context={diagnostics:request.diagnosticContext.diagnostics.map(d=>({range:d.range,severity:Object.keys(severity).find(k=>severity[k]===d.severity)*1,message:d.message,...(d.code?{code:d.code}:{})})),triggerKind:request.context.triggerKind==='automatic'?2:1,...(request.context.only?{only:request.context.only}:{})};
        const raw=await rpc.request(feature.method,params,{signal:clock.signal,timeoutMs:requestTimeoutMs});current(request.snapshot,epoch);
        const data=await transform(request,raw,clock.signal);await access('read',doc.path,clock.signal);current(request.snapshot,epoch);return createLanguageResult(request,data);
      }catch(error){if(epoch!==generation)fail('STALE','Document changed while the server was working');throw error;}
      finally{clock.close();requests.delete(request.requestId);callerSignal?.removeEventListener('abort',cancel);}
    },
    provider(kind){const feature=matrix.features.find(f=>f.sdkFeature===kind);if(!feature?.supported)fail('UNSUPPORTED','Provider capability unavailable');return Object.freeze({provide:(request,options)=>{if(request.kind!==kind)fail('INVALID','Wrong provider feature');return api.request(request,options);}});},
    close(){if(closePromise)return closePromise;state='closing';invalidate();return closePromise=(async()=>{
      let graceful=false,reason=null;
      try{
        await docTail;
        if(!rpc.inspect().closed){for(const doc of documents.values())await rpc.notify('textDocument/didClose',{textDocument:{uri:doc.snapshot.uri}});await rpc.request('shutdown',undefined,{timeoutMs:Math.min(requestTimeoutMs,1000)});await rpc.notify('exit');graceful=true;
          let timer;try{await Promise.race([proc.finished,new Promise(r=>{timer=setTimeout(r,500);})]);}finally{clearTimeout(timer);}}
        else reason=rpc.inspect().failure;
      }catch(error){reason=errorCode(error);}
      finally{documents.clear();signal?.removeEventListener('abort',abort);await rpc.close();lifetime.abort();state='closed';}
      return immutable({schemaVersion:1,graceful,reason,ownedProcessClosed:proc.inspect().closed,pendingRequests:rpc.inspect().pending});
    })();},
  };
  return Object.freeze(api);
}
