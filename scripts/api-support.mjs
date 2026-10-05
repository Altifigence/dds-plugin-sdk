import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {SDK_PLUGIN_PEER_RANGE} from '../src/version.mjs';
const mode=process.argv[2];if(!['--write','--check'].includes(mode))throw Error('Use --write or --check');
const root=new URL('../',import.meta.url),pkg=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
const optional=new Set(['./workspace-node','./workspace-client','./jobs','./artifacts','./job-storage','./job-history','./job-storage-node','./artifact-storage','./artifact-storage-node','./workspace-edits','./workspace-edits-node','./project-watch','./project-watch-node','./project-query','./project-query-node','./artifact-transfer','./artifact-transfer-browser','./uploads','./uploads-node','./uploads-browser','./artifact-resume-browser','./transfer-queue','./settings','./secrets']);
const nodeOnly=new Set(['./publishing','./devtools','./workspace-node','./job-storage-node','./artifact-storage-node','./workspace-edits-node','./project-watch-node','./project-query-node','./uploads-node','./conformance-node']);
function typeNames(source){
  const file=ts.createSourceFile('entry.d.mts',source,ts.ScriptTarget.Latest,true),names=new Set();
  for(const statement of file.statements){
    if(ts.isExportDeclaration(statement)&&statement.exportClause&&ts.isNamedExports(statement.exportClause))for(const entry of statement.exportClause.elements)names.add(entry.name.text);
    if(statement.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)){
      if(statement.name)names.add(statement.name.text);
      if(ts.isVariableStatement(statement))for(const declaration of statement.declarationList.declarations)if(ts.isIdentifier(declaration.name))names.add(declaration.name.text);
    }
  }
  return [...names].sort();
}
const exports=[];
for(const [entry,files] of Object.entries(pkg.exports).sort(([a],[b])=>a.localeCompare(b,'en'))){
  if(typeof files==='string'){exports.push({entry,stability:'metadata',availability:'data',environments:['node','browser'],runtimeNames:[],declarationNames:[],declarationsSha256:null});continue;}
  const body=(await readFile(new URL(files.types,root),'utf8')).replaceAll('\r\n','\n'),runtimeNames=Object.keys(await import(new URL(files.import,root))).sort();
  exports.push({entry,stability:entry==='./artifact-resume-browser'?'experimental':'stable',availability:optional.has(entry)?'optional':'library',environments:nodeOnly.has(entry)?['node']:['node','browser'],runtimeNames,declarationNames:typeNames(body),declarationsSha256:createHash('sha256').update(body).digest('hex')});
}
const value={schemaVersion:1,sdkVersion:pkg.version,releaseStatus:pkg.version.includes('-')?'candidate':'stable',pluginPeerRange:SDK_PLUGIN_PEER_RANGE,policy:'docs/SUPPORT_POLICY.md',exports};
const expected=JSON.stringify(value,null,2)+'\n',destination=new URL('API_SUPPORT.json',root);
if(mode==='--write')await writeFile(destination,expected);else if(await readFile(destination,'utf8')!==expected)throw Error('Public API inventory drift; review and run npm run api:write');
console.log(`API inventory ${mode==='--write'?'generated':'verified'}: ${exports.length} exports; ${exports.reduce((n,e)=>n+e.runtimeNames.length,0)} runtime names; ${exports.reduce((n,e)=>n+e.declarationNames.length,0)} declarations.`);
