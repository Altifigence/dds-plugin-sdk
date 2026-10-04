import * as fs from 'node:fs/promises';
import path from 'node:path';
import {parseManifest} from './contracts.mjs';
import {SDK_VERSION} from './version.mjs';
import {createGeneratedContracts,PLUGIN_TEMPLATES} from './dev-generation.mjs';
import {devJson,devOptions,devFailure,readDevFile,newDirectoryPath,destinationExists,fileInventory,checkedFiles,writeNewDirectory} from './dev-files.mjs';
import {freezeConfiguration} from './configuration-values.mjs';

const sdkImport="import {definePlugin} from '@altifigence/dds-plugin-sdk';\nimport manifest from './plugin.json' with {type:'json'};\nimport {commands} from './generated/contracts.mjs';\n";
const greet={id:'greet',title:'Say hello',parameters:[{name:'name',label:'Your name',type:'string',required:true}]};
const theme={name:'My Ocean',colors:{light:{backdrop:'#dbe8ef',navigation:'#edf5f8',tool:'#f3f8fb',main:'#ffffff',text:'#183b4e',muted:'#486477'},dark:{backdrop:'#0c1922',navigation:'#102430',tool:'#17303e',main:'#1c3949',text:'#e8f4fb',muted:'#adcadb'}}};
function definitions(template,id){
  const definition={schemaVersion:1,template,commands:template==='language'?[]:template==='theme'?[{id:'inspect-theme',title:'Inspect theme'}]:[greet]};
  if(template==='theme')definition.theme=theme;
  if(template==='configuration'){
    definition.commands=[{id:'greet',title:'Summarize values',display:{labelKey:'greet',accessibility:{nameKey:'greet',shortcut:'Control+Enter'}},inputSchema:{schemaVersion:1,schema:{type:'object',additionalProperties:false,properties:{name:{type:'string',minLength:1,maxLength:64},values:{type:'array',maxItems:8,items:{type:'number',minimum:0,maximum:100},default:[1,2]}},required:['name','values']}},outputSchema:{schemaVersion:1,schema:{type:'object',additionalProperties:false,properties:{message:{type:'string',maxLength:256},total:{type:'number'}},required:['message','total']}}}];
    definition.settings={schemaVersion:1,pluginId:id,version:1,settings:{multiplier:{schema:{schemaVersion:1,schema:{type:'integer',minimum:1,maximum:10,default:2}},scopes:['user','workspace'],display:{labelKey:'count',accessibility:{nameKey:'count'}}}}};
    definition.catalog={schemaVersion:1,defaultLocale:'en',messages:{en:{greet:'Summarize',count:'Multiplier',done:'Total {count}'},ko:{greet:'합계 계산',count:'배수',done:'합계 {count}'}}};
  }
  return definition;
}
function pluginSource(template){
  if(template==='language')return `import {definePlugin,createDiagnosticsResult,createLanguageResult} from '@altifigence/dds-plugin-sdk';
import manifest from './plugin.json' with {type:'json'};
export default definePlugin(manifest, context => {
  context.registerDiagnosticsProvider({languages:['template']},{provideDiagnostics(request,{signal}){
    signal.throwIfAborted();const diagnostics=[];
    request.snapshot.text.split(/\\r\\n|\\n|\\r/).forEach((line,index)=>{const at=line.indexOf('TODO');if(at>=0)diagnostics.push({range:{start:{line:index,character:at},end:{line:index,character:at+4}},severity:'info',code:'todo',message:'Resolve the TODO.'});});
    return createDiagnosticsResult(request,diagnostics);
  }});
  context.registerLanguageProvider('hover',{languages:['template']},{provide(request){return createLanguageResult(request,{text:'Template language provider'});}});
  context.registerLanguageProvider('completion',{languages:['template']},{provide(request){return createLanguageResult(request,[{label:'sample',insertText:'sample'}]);}});
});
`;
  if(template==='theme')return sdkImport+`import {theme} from './generated/contracts.mjs';
export default definePlugin(manifest,context=>context.registerCommand(commands['inspect-theme'],()=>({themeName:theme.name,light:theme.colors.light.main,dark:theme.colors.dark.main})));
`;
  if(template==='configuration')return sdkImport+`export {settingsDefinition,catalog} from './generated/contracts.mjs';
export default definePlugin(manifest,context=>context.registerCommand(commands.greet,async(input,{signal})=>{
  signal.throwIfAborted();const snapshot=await context.settings.read({signal});
  return {message:'Hello, '+input.name+'!',total:input.values.reduce((sum,value)=>sum+value,0)*snapshot.values.multiplier};
}));
`;
  if(template==='job')return sdkImport+`export default definePlugin(manifest,context=>context.registerCommand(commands.greet,async(input,{signal,job})=>{
  if(!job)throw new Error('Start this command as a job');
  for(let i=1;i<=3;i++){signal.throwIfAborted();job.reportProgress({completed:i,total:3});job.log('info','Completed synthetic step '+i);await Promise.resolve();}
  return {message:'Hello, '+input.name+'!',pluginId:context.pluginId};
}));
`;
  return sdkImport+`export default definePlugin(manifest,context=>context.registerCommand(commands.greet,(input,{signal,job})=>{
  signal.throwIfAborted();job?.reportProgress({completed:1,total:1,message:'Greeting ready'});job?.log('info','Greeting command completed');
  return {message:'Hello, '+input.name+'!',pluginId:context.pluginId};
}));
`;
}
function exerciseSource(template){
  const grants=template==='language'?['document.read','diagnostics.publish','language.provide']:template==='configuration'?['settings.read']:[];
  let action;
  if(template==='language')action=`const document={uri:'memory:///template.txt',languageId:'template',modelVersion:1,workspaceRevision:'one',text:'TODO sample'};
    host.setDocument(document);assert.equal((await host.requestDiagnostics()).diagnostics.length,1);
    assert.equal((await host.requestLanguage('hover',{position:{line:0,character:5}})).data.text,'Template language provider');
    assert.equal((await host.requestLanguage('completion',{position:{line:0,character:5}})).data[0].insertText,'sample');
    host.setDocument({...document,modelVersion:2,text:'Done'});assert.equal((await host.requestDiagnostics()).diagnostics.length,0);`;
  else if(template==='theme')action=`assert.equal((await host.executeCommand(plugin.manifest.id,'inspect-theme',{})).themeName,theme.name);
    assert.equal(await readFile(new URL('./generated/theme.xml',import.meta.url),'utf8'),serializeThemeXml(theme));`;
  else if(template==='configuration')action=`assert.equal((await host.executeCommand(plugin.manifest.id,'greet',{name:'Developer'})).total,6);
    settings.update({workspaceId:'template-project',scope:'workspace',expectedRevision:0,values:{multiplier:3}});
    assert.equal((await host.executeCommand(plugin.manifest.id,'greet',{name:'Developer'})).total,9);
    await assert.rejects(host.executeCommand(plugin.manifest.id,'greet',{name:''}),{code:'invalid_contract'});`;
  else if(template==='job')action=`const id=crypto.randomUUID();host.startCommandJob(plugin.manifest.id,'greet',{name:'Developer'},{jobId:id});
    let result;for(let i=0;i<100;i++){result=host.getJob(id);if(result.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,5));}
    assert.equal(result.state,'succeeded');assert.equal(result.result.message,'Hello, Developer!');
    assert.equal(host.getJobEvents(id).events.filter(e=>e.kind==='log').length,3);`;
  else action=`assert.deepEqual(await host.executeCommand(plugin.manifest.id,'greet',{name:'Developer'}),{message:'Hello, Developer!',pluginId:plugin.manifest.id});
    await assert.rejects(host.executeCommand(plugin.manifest.id,'greet',{}),{code:'invalid_contract'});`;
  return `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import {createSettingsStore} from '@altifigence/dds-plugin-sdk/settings';
import {serializeThemeXml} from '@altifigence/dds-plugin-sdk/themes';
import plugin from './plugin.mjs';
import {settingsDefinition,theme} from './generated/contracts.mjs';
export async function exercise(){
  const settings=settingsDefinition?createSettingsStore(settingsDefinition):null;
  const host=createPluginHost({scope:{projectId:'template-project',sessionId:'template-session'},grants:${JSON.stringify(grants)},jobs:true,settings:settings?{[plugin.manifest.id]:settings}:{}});
  try{await host.activate(plugin);
    ${action}
    return {template:${JSON.stringify(template)},verified:true};
  }finally{host.dispose();settings?.dispose();}
}
`;
}
const browserHtml=`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DDS plugin example</title>
<style>:root{color-scheme:light dark;font-family:system-ui}body{max-width:48rem;margin:3rem auto;padding:0 1rem}form{display:grid;gap:1rem}label{display:grid;gap:.35rem}[hidden]{display:none!important}input,select,button{font:inherit;padding:.6rem;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{cursor:pointer}small{opacity:.8}</style>
<h1>DDS plugin example</h1><p>This form executes the local example plugin in this browser.</p>
<form id="form"><label>Name<input id="name" value="Ada" maxlength="64" required></label>
<label id="locale-label">Language<select id="locale"><option value="en">English</option><option value="ko">한국어</option></select></label>
<label id="multiplier-label">Multiplier<input id="multiplier" type="number" value="2" min="1" max="10"></label>
<button id="run" type="submit">Run</button><small>Ctrl+Enter runs the same command.</small></form>
<pre id="result" role="status" aria-live="polite">Ready</pre>
<script type="importmap">{"imports":{"@altifigence/dds-plugin-sdk":"/sdk/index.mjs","@altifigence/dds-plugin-sdk/settings":"/sdk/settings.mjs","@altifigence/dds-plugin-sdk/localization":"/sdk/localization.mjs","@altifigence/dds-plugin-sdk/themes":"/sdk/themes.mjs"}}</script>
<script type="module" src="/browser.mjs"></script></html>
`;
const browserModule=`import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import {createSettingsStore} from '@altifigence/dds-plugin-sdk/settings';
import {resolveMessage} from '@altifigence/dds-plugin-sdk/localization';
import plugin from './plugin.mjs';
import {settingsDefinition,catalog} from './generated/contracts.mjs';
const settings=settingsDefinition?createSettingsStore(settingsDefinition):null;
const host=createPluginHost({scope:{projectId:'template-project',sessionId:'browser-session'},grants:settings?['settings.read']:[],settings:settings?{[plugin.manifest.id]:settings}:{}});
await host.activate(plugin);
const form=document.querySelector('#form'),output=document.querySelector('#result'),button=document.querySelector('#run'),locale=document.querySelector('#locale');
document.querySelector('#multiplier-label').hidden=!settings;document.querySelector('#locale-label').hidden=!catalog;
function localize(){document.documentElement.lang=locale.value;if(catalog)button.textContent=resolveMessage(catalog,locale.value,'greet').text;}
locale.addEventListener('change',localize);localize();let running=false;
form.addEventListener('submit',async event=>{event.preventDefault();if(running)return;running=true;button.disabled=true;
  try{if(settings){const snapshot=settings.read('template-project');settings.update({workspaceId:'template-project',scope:'workspace',expectedRevision:snapshot.revision,values:{multiplier:Number(document.querySelector('#multiplier').value)}});}
    const result=await host.executeCommand(plugin.manifest.id,'greet',{name:document.querySelector('#name').value});
    output.textContent=catalog?resolveMessage(catalog,locale.value,'done',{count:result.total}).text:JSON.stringify(result,null,2);
  }catch(error){output.textContent='Failed: '+(error.code??'invalid_contract');}finally{running=false;button.disabled=false;}
});
document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();form.requestSubmit();}});
window.addEventListener('pagehide',()=>{host.dispose();settings?.dispose();},{once:true});
`;
function browserServer(files){return `import {createServer} from 'node:http';
import {readFile,lstat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=path.dirname(fileURLToPath(import.meta.url)),sdk=path.join(path.dirname(createRequire(import.meta.url).resolve('@altifigence/dds-plugin-sdk/package.json')),'src');
const allowed=new Set(${JSON.stringify(files)});let origin;
const server=createServer(async(req,res)=>{
  try{if(req.method!=='GET'||req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin){res.writeHead(403).end();return;}
    const pathname=new URL(req.url,origin).pathname;let filename;
    if(/^\\/sdk\\/[a-z][a-z0-9.-]*\\.mjs$/.test(pathname))filename=path.join(sdk,pathname.slice(5));
    else{const relative=pathname==='/'?'browser.html':pathname.slice(1);if(!allowed.has(relative)){res.writeHead(404).end();return;}filename=path.join(root,relative);}
    const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink()||info.size>1_048_576){res.writeHead(404).end();return;}
    const body=await readFile(filename);res.writeHead(200,{'Content-Type':filename.endsWith('.html')?'text/html; charset=utf-8':filename.endsWith('.json')?'application/json':'text/javascript; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(body);
  }catch{res.writeHead(404).end();}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;console.log(origin+'/');
const stop=()=>{server.closeAllConnections();server.close();};process.once('SIGINT',stop);process.once('SIGTERM',stop);
`;
}
export async function scaffoldContents(directory,options={}) {
  devOptions(options,['id','publisher','name','template','license','licenseFile','dryRun']);
  if(options.dryRun!==undefined&&typeof options.dryRun!=='boolean')throw devFailure('invalid_options','Invalid dryRun option');
  const target=await newDirectoryPath(directory),template=options.template??'command',license=options.license??'Apache-2.0';
  if(!PLUGIN_TEMPLATES.includes(template))throw devFailure('invalid_options','Unknown plugin template');
  if(!['Apache-2.0','LicenseRef-Proprietary'].includes(license)||license==='LicenseRef-Proprietary'&&typeof options.licenseFile!=='string'||license==='Apache-2.0'&&options.licenseFile!==undefined)throw devFailure('invalid_options','Choose Apache-2.0 or LicenseRef-Proprietary with an explicit licenseFile');
  const language=template==='language',configuration=template==='configuration';
  const manifest=parseManifest({manifestVersion:2,id:options.id??path.basename(target),publisher:options.publisher??'example',name:options.name??'My DDS Plugin',version:'0.1.0',protocolVersion:1,entry:'./plugin.mjs',runtime:language||template==='browser'?'ui':'workspace',capabilities:language?['diagnostics','hover','completion']:configuration?['commands','settings']:['commands'],permissions:language?['document.read','diagnostics.publish','language.provide']:configuration?['settings.read']:[],supportedHosts:['test-host','workspace-host'],license,source:{visibility:license==='Apache-2.0'?'open':'closed',licenseFile:'LICENSE'}});
  if(`@${manifest.publisher}/${manifest.id}`.length>214)throw devFailure('invalid_options','Publisher and plugin ID exceed the package name limit');
  const inheritedLicense=await fs.readFile(new URL('../LICENSE',import.meta.url),'utf8'),notice=await fs.readFile(new URL('../NOTICE',import.meta.url),'utf8');
  const selectedLicense=license==='Apache-2.0'?inheritedLicense:await readDevFile(path.resolve(options.licenseFile),65_536);
  if(!selectedLicense.trim()||selectedLicense.includes('\0'))throw devFailure('invalid_license','Provide the actual nonempty publisher license text');
  const definition=definitions(template,manifest.id),generated=createGeneratedContracts(manifest,definition),files=new Map([
    ['plugin.json',devJson(manifest)],['dds-dev.json',devJson(definition)],['plugin.mjs',pluginSource(template)],['exercise.mjs',exerciseSource(template)],
    ['run.mjs',"import {exercise} from './exercise.mjs';\nconsole.log(JSON.stringify(await exercise()));\n"],
    ['plugin.test.mjs',"import test from 'node:test';\nimport {exercise} from './exercise.mjs';\ntest('the generated plugin satisfies its declared contracts',exercise);\n"],
    ['LICENSE',selectedLicense],['LICENSE.sdk',inheritedLicense],['NOTICE',notice],['.gitignore','node_modules/\ndist/\n.dds-generate.lock\n.dds-generation-*/\n'],
    ['tsconfig.json',devJson({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,skipLibCheck:false},include:['typecheck.mts','generated/*.d.mts']})],
    ['typecheck.mts',`import {commands,type CommandInputs,type CommandOutputs,type SettingsValues} from './generated/contracts.mjs';\n${definition.commands.length?`const input: CommandInputs[${JSON.stringify(definition.commands[0].id)}] = ${template==='theme'?'{}':JSON.stringify({name:'Developer'})};\nvoid input;`:''}void commands;\nexport type OutputMap = CommandOutputs;\nexport type Settings = SettingsValues;\n`],
  ]);
  for(const [name,text]of generated.files)files.set('generated/'+name,text);
  if(template==='browser'||configuration){files.set('browser.html',browserHtml);files.set('browser.mjs',browserModule);files.set('serve.mjs',browserServer(['browser.html','browser.mjs','plugin.json','plugin.mjs','generated/contracts.json','generated/contracts.mjs']));}
  const packageFiles=[...files.keys()].filter(name=>!['.gitignore','plugin.test.mjs','exercise.mjs','run.mjs','tsconfig.json','typecheck.mts','serve.mjs'].includes(name));
  files.set('dds-package.json',devJson({schemaVersion:1,files:packageFiles}));
  files.set('disclosure.json',devJson({schemaVersion:1,publisher:manifest.publisher,pluginId:manifest.id,pluginVersion:manifest.version,license:manifest.license,sourceVisibility:manifest.source.visibility,supportUrl:'https://example.com/support',dataUse:language?'Processes the supplied synthetic document in memory and returns literal diagnostics and language suggestions.':configuration?'Uses the supplied name and numbers with an operator-mounted memory setting. No network or file access.':template==='theme'?'Returns bundled theme metadata. The generated XML is imported separately by the user.':'Uses the supplied name for a greeting. No workspace reads, external backends or persisted input.',backends:[]}));
  const distribution=JSON.parse(files.get('dds-package.json'));distribution.files.push('disclosure.json');files.set('dds-package.json',devJson(distribution));
  const scripts={test:'node --test plugin.test.mjs',typecheck:'tsc --project tsconfig.json',doctor:'dds-plugin doctor .',generate:'dds-plugin generate .','check:generated':'dds-plugin generate . --check',example:'node run.mjs',dev:'dds-plugin dev . --trust-local-code --watch','validate:plugin':'dds-plugin validate .','pack:plugin':'dds-plugin pack . --out dist'};
  if(template==='browser'||configuration)scripts.browser='node serve.mjs';
  files.set('package.json',devJson({name:`@${manifest.publisher}/${manifest.id}`,version:manifest.version,private:true,type:'module',scripts,dependencies:{'@altifigence/dds-plugin-sdk':`https://github.com/Altifigence/dds-plugin-sdk/releases/download/v${SDK_VERSION}/altifigence-dds-plugin-sdk-${SDK_VERSION}.tgz`},devDependencies:{typescript:'5.9.3'}}));
  const command=template==='theme'?'inspect-theme':'greet';
  files.set('README.md',`# ${manifest.name}

Template: ${template}. Generated with DDS Plugin SDK ${SDK_VERSION}.

Run these commands deliberately; generation itself installs or executes nothing:

\`\`\`sh
npm install --ignore-scripts
npm run doctor
npm test
npm run typecheck
npm run example
${template==='browser'||configuration?'npm run browser\n':''}\`\`\`

${language?'The example grants document.read, diagnostics.publish and language.provide to this local teaching-language plugin. It does not start an external language server.':template==='theme'?'The command inspects the bundled palette. Import generated/theme.xml through the normal DDS theme UI when desired; generating it does not apply a theme.':configuration?'The example explicitly grants settings.read and mounts an in-memory store. Edit its selected user/workspace values in the example host; generation never discovers credentials.':template==='job'?'The example starts a job explicitly and checks its logs, progress and terminal success. It does not launch external tools.':'The example executes a command in a local SDK host with no workspace or backend grants.'}

${!language&&!configuration?`For trusted local command development: \`npx --no-install dds-plugin dev . --trust-local-code ${template==='job'?'--job ':''}--command ${command} --input '${template==='theme'?'{}':'{"name":"World"}'}'\`.\n`:''}
Edit dds-dev.json for command/schema/settings/catalog/theme metadata. Run \`npm run check:generated\` to detect drift. \`dds-plugin generate . --dry-run\` reports the current and proposed digests. To replace unchanged SDK-generated files, supply their previous digest with \`--expected-digest\`. Edited or additional files inside generated/ are preserved and cause a conflict; save them elsewhere deliberately before regenerating. The generator never merges edits or executes metadata. Add newly generated schemas to the explicit dds-package.json file list; doctor detects missing distribution entries.

Generated contracts.d.mts describes raw and validated inputs, outputs and effective setting values. Runtime validators still enforce numeric, string, complexity and byte limits. JSON schemas are structural projections; aggregate limits and authorization require SDK checks.

Review publisher/support information and disclosure.json before distribution. The selected publisher license is in LICENSE; inherited SDK/scaffold Apache-2.0 terms remain in LICENSE.sdk and NOTICE. The proprietary option uses the caller's supplied terms and does not conceal distributed JavaScript. No third-party runtime binaries are copied; TypeScript is a separate pinned development dependency.

Use \`npm run pack:plugin\` to build the allowlisted plugin archive. Local examples execute trusted code in process; the dev child is not an OS sandbox. Browser examples bind only 127.0.0.1 and serve the declared demo files plus installed public SDK modules. Stop the example with Ctrl+C.
`);
  return {target,manifest,template,files:checkedFiles(files),generationDigest:generated.receipt.digest};
}
export async function planPlugin(directory,options={}) {
  const plan=await scaffoldContents(directory,options),exists=await destinationExists(plan.target);
  return freezeConfiguration({schemaVersion:1,directory:plan.target,pluginId:plan.manifest.id,template:plan.template,sdkVersion:SDK_VERSION,generationDigest:plan.generationDigest,files:fileInventory(plan.files),conflicts:exists?[{path:'.',reason:'destination_exists'}]:[],writes:false});
}
export async function initPlugin(directory,options={}) {
  if(options&&Object.getOwnPropertyDescriptor(options,'dryRun')?.value===true)return planPlugin(directory,options);
  const plan=await scaffoldContents(directory,options);await writeNewDirectory(plan.target,plan.files);
  return freezeConfiguration({directory:plan.target,pluginId:plan.manifest.id,template:plan.template,sdkVersion:SDK_VERSION,generationDigest:plan.generationDigest,files:[...plan.files.keys()],next:['npm install --ignore-scripts','npm run doctor','npm test','npm run typecheck','npm run example']});
}
