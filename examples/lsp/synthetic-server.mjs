// Independent public LSP fixture. It deliberately does not import the SDK parser or adapters.
if(process.argv.includes('--version')){process.stdout.write('DDS LSP fixture 1.0.0\n');process.exit(0);}
const mode=process.argv[2]??'normal',documents=new Map();let buffer=Buffer.alloc(0),shutDown=false;
const range=(line,start,end)=>({start:{line,character:start},end:{line,character:end}});
function send(message){const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',...message}));process.stdout.write(`Content-Length: ${bytes.length}\r\n\r\n`);process.stdout.write(bytes);}
const result=(id,value)=>send({id,result:value});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function receive(message){
  const {id,method,params}=message;
  if(method==='initialize'){
    if(mode==='frame'){process.stdout.write('Content-Length: nope\r\n\r\n{}');return;}
    result(id,{serverInfo:{name:'DDS LSP fixture',version:'1.0.0'},capabilities:{positionEncoding:mode==='encoding'?'utf-8':'utf-16',textDocumentSync:{openClose:true,change:2},completionProvider:{resolveProvider:false},hoverProvider:mode!=='unsupported',definitionProvider:true,referencesProvider:true,documentSymbolProvider:true,signatureHelpProvider:{triggerCharacters:['(',',']},renameProvider:{prepareProvider:true},documentFormattingProvider:true,documentRangeFormattingProvider:true,codeActionProvider:true,semanticTokensProvider:{full:true,legend:{tokenTypes:['keyword','variable'],tokenModifiers:[]}},foldingRangeProvider:true,inlayHintProvider:true}});return;
  }
  if(method==='initialized'){if(mode==='server-request')send({id:'server-edit',method:'workspace/applyEdit',params:{edit:{changes:{}}}});return;}
  if(method==='textDocument/didOpen'||method==='textDocument/didChange'){
    const doc=method.endsWith('didOpen')?params.textDocument:{...documents.get(params.textDocument.uri),version:params.textDocument.version,text:params.contentChanges[0].text};documents.set(doc.uri,doc);
    send({method:'textDocument/publishDiagnostics',params:{uri:doc.uri,...(mode==='unversioned'?{}:{version:doc.version}),diagnostics:[{range:range(0,6,11),severity:2,message:'Fixture model '+doc.version,source:'fixture'}]}});return;
  }
  if(method==='textDocument/didClose'){documents.delete(params.textDocument.uri);return;}
  if(method==='$/cancelRequest')return;
  if(method==='shutdown'){if(mode==='shutdown'){send({id,error:{code:-32000,message:'Synthetic shutdown refusal'}});return;}shutDown=true;result(id,null);return;}
  if(method==='exit'){process.exit(shutDown?0:1);}
  if(id===undefined||!method)return;
  const uri=params?.textDocument?.uri,doc=documents.get(uri),nameRange=range(0,6,11);
  if(method==='textDocument/hover'){
    if(mode==='crash'){process.exit(7);}if(mode==='timeout')return;if(mode==='late')await pause(100);
    const value={contents:{kind:'plaintext',value:'value: number'},range:mode==='invalid-range'?range(99,0,1):nameRange};result(id,value);if(mode==='duplicate')result(id,value);return;
  }
  if(method==='textDocument/completion'){result(id,{isIncomplete:false,items:[{label:'value',insertText:'value',detail:'local number'}]});return;}
  if(method==='textDocument/definition'||method==='textDocument/references'){result(id,[{uri:mode==='external'?new URL('../outside.ts',uri).href:uri,range:nameRange}]);return;}
  if(method==='textDocument/documentSymbol'){result(id,[{name:'value',kind:13,range:range(0,0,16),selectionRange:nameRange}]);return;}
  if(method==='textDocument/signatureHelp'){result(id,{signatures:[{label:'add(a: number, b: number): number',parameters:[{label:'a: number'},{label:'b: number'}]}],activeSignature:0,activeParameter:1});return;}
  if(method==='textDocument/prepareRename'){result(id,{range:nameRange,placeholder:'value'});return;}
  if(method==='textDocument/rename'){result(id,{documentChanges:[{textDocument:{uri:mode==='outside-edit'?new URL('../outside.ts',uri).href:uri,version:doc.version},edits:[{range:nameRange,newText:params.newName}]}]});return;}
  if(method==='textDocument/formatting'||method==='textDocument/rangeFormatting'){result(id,[{range:range(0,0,16),newText:'const value=1;'}]);return;}
  if(method==='textDocument/codeAction'){result(id,[{title:'Change value',kind:'quickfix',edit:{changes:{[uri]:[{range:range(0,14,15),newText:'2'}]}}},{title:'Run external command',kind:'quickfix',command:{title:'External',command:'not-permitted'}}]);return;}
  if(method==='textDocument/semanticTokens/full'){result(id,{resultId:'fixture-tokens',data:[0,0,5,0,0,0,6,5,1,0]});return;}
  if(method==='textDocument/foldingRange'){result(id,[{startLine:1,startCharacter:0,endLine:3,endCharacter:1,kind:'region'}]);return;}
  if(method==='textDocument/inlayHint'){result(id,[{position:{line:0,character:11},label:': number',kind:1}]);return;}
  send({id,error:{code:-32601,message:'Unsupported fixture request'}});
}
process.stdin.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(true){const end=buffer.indexOf('\r\n\r\n');if(end<0)break;const match=/Content-Length: (\d+)/i.exec(buffer.subarray(0,end).toString());if(!match)process.exit(2);const length=Number(match[1]);if(buffer.length<end+4+length)break;const message=JSON.parse(buffer.subarray(end+4,end+4+length));buffer=buffer.subarray(end+4+length);receive(message).catch(()=>process.exit(3));}
});
process.stdin.on('end',()=>process.exit(shutDown?0:1));
