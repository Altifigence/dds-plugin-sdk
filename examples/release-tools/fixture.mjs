import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {definePlugin,createPluginHost} from '@altifigence/dds-plugin-sdk';
import {packPlugin} from '@altifigence/dds-plugin-sdk/publishing';
import {createPluginBundle,lockBundleDependency,installPluginBundle,verifyPluginBundle} from '@altifigence/dds-plugin-sdk/bundles';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function makeExampleBundle(directory,version='1.0.0',offset=1,permissions=[]){
  await mkdir(directory,{recursive:true});
  const license=await readFile(new URL('../../LICENSE',import.meta.url),'utf8');
  const manifest={manifestVersion:2,id:'release-tools-example',name:'Release Tools Example',publisher:'example',version,protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions,supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
  const code=`import {twice} from 'dds-example-math';\nexport function activate(context) { return context.registerCommand({id:'compute',title:'Compute'},async(input,{signal})=>{ if(input.delay) await new Promise(resolve=>setTimeout(resolve,input.delay)); signal.throwIfAborted(); return {value:twice(input.value)+${offset},version:${JSON.stringify(version)}}; }); }\n`;
  const disclosure={schemaVersion:1,publisher:manifest.publisher,pluginId:manifest.id,pluginVersion:version,license:manifest.license,sourceVisibility:'open',supportUrl:'https://github.com/Altifigence/dds-plugin-sdk/issues',dataUse:'Only explicit invented example input.',backends:[]};
  const files={'plugin.json':JSON.stringify(manifest),'plugin.mjs':code,'LICENSE':license,'NOTICE':'SDK authored example. No third-party dependency code.','disclosure.json':JSON.stringify(disclosure)};
  await writeFile(path.join(directory,'dds-package.json'),JSON.stringify({schemaVersion:1,files:Object.keys(files)}));
  for(const [name,content]of Object.entries(files))await writeFile(path.join(directory,name),content);
  const packed=await packPlugin(directory,{out:path.join(directory,'dist')});
  const dependency=lockBundleDependency({name:'dds-example-math',version:'1.0.0',source:'https://github.com/Altifigence/dds-plugin-sdk',entry:'index.mjs',type:'module',dependencies:{},license:'Apache-2.0',licenseFile:'LICENSE',noticeFile:'NOTICE',redistributable:true,files:[{path:'index.mjs',data:Buffer.from('export const twice=value=>value*2;\n').toString('base64')},{path:'LICENSE',data:Buffer.from(license).toString('base64')},{path:'NOTICE',data:Buffer.from('SDK authored arithmetic example.').toString('base64')}]});
  const input={plugin:{archive:(await readFile(packed.archivePath)).toString('base64'),metadata:JSON.parse(await readFile(packed.metadataPath,'utf8')),sha256:packed.artifact.sha256},dependencies:{'dds-example-math':'1.0.0'},packages:[dependency]};
  return {bundle:createPluginBundle(input),input,manifest,packed};
}
export async function loadExampleHost(bundle,destination,grants=[]){
  const receipt=verifyPluginBundle(bundle);await installPluginBundle(bundle,{destination,expectedSha256:receipt.sha256,approved:true});
  const manifest=JSON.parse(await readFile(path.join(destination,'plugin.json'),'utf8'));
  const implementation=await import(pathToFileURL(path.join(destination,'plugin.mjs')).href);
  const host=createPluginHost({hostId:'workspace-host',grants});
  try{await host.activate(definePlugin(manifest,implementation.activate));}catch(error){host.dispose();throw error;}
  return {execute(input,{signal}={}){return host.executeCommand(manifest.id,'compute',input,{signal});},dispose(){host.dispose();}};
}
