import path from 'node:path';
import {parseManifest,parseCommandDefinition} from './contracts.mjs';
import {parseSettingsDefinition} from './settings.mjs';
import {parseLocaleCatalog,validateLocalizedSurfaces} from './localization.mjs';
import {parseTheme,serializeThemeXml} from './themes.mjs';
import {configurationCopy,configurationObject,freezeConfiguration} from './configuration-values.mjs';
import {SDK_VERSION} from './version.mjs';
import {devJson,devHash,devFailure,devOptions,readDevFile,realDirectory,fileInventory,checkedFiles,destinationExists,inspectGeneratedDirectory,replaceGeneratedDirectory} from './dev-files.mjs';

export const PLUGIN_TEMPLATES=Object.freeze(['command','language','theme','job','browser','configuration']);
export const DEVTOOLS_LIMITS=Object.freeze({definitionBytes:262_144,commands:64,generatedFiles:256,generatedBytes:4_194_304});
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export function parseDevelopmentDefinition(input, manifest) {
  const value=configurationCopy(input,DEVTOOLS_LIMITS.definitionBytes);
  configurationObject(value,['schemaVersion','template','commands'],['settings','catalog','theme']);
  if(value.schemaVersion!==1||!PLUGIN_TEMPLATES.includes(value.template)||!Array.isArray(value.commands)||value.commands.length>64)throw devFailure('invalid_definition','Unsupported development definition');
  const commands=value.commands.map(parseCommandDefinition);
  if(new Set(commands.map(c=>c.id)).size!==commands.length)throw devFailure('invalid_definition','Duplicate development command ID');
  const result={schemaVersion:1,template:value.template,commands};
  if(Object.hasOwn(value,'settings'))result.settings=parseSettingsDefinition(value.settings);
  if(Object.hasOwn(value,'catalog'))result.catalog=parseLocaleCatalog(value.catalog);
  if(Object.hasOwn(value,'theme'))result.theme=parseTheme(value.theme);
  if(manifest){
    manifest=parseManifest(manifest);
    if(commands.length&&!manifest.capabilities.includes('commands'))throw devFailure('invalid_definition','Development commands require the commands capability');
    if(result.settings&&(result.settings.pluginId!==manifest.id||!manifest.capabilities.includes('settings')||!manifest.permissions.includes('settings.read')))throw devFailure('invalid_definition','Settings definition must match the plugin and declared settings capability/permission');
  }
  if(result.catalog)validateLocalizedSurfaces(result.catalog,{...(manifest?{manifest}:{}),commands,...(result.settings?{settings:result.settings}:{})});
  return freezeConfiguration(result);
}
function schemaType(node, mode='output') {
  if(node.format==='dds-secret-reference')return 'SecretReference';
  if(node.enum)return node.enum.map(value=>JSON.stringify(value)).join(' | ');
  if(node.type==='object'){
    const fields=Object.entries(node.properties).map(([key,value])=>{
      const hasDefault=Object.hasOwn(value,'default'),required=mode==='input'&&hasDefault?false:node.required?.includes(key)||mode==='validated'&&hasDefault;
      return `readonly ${JSON.stringify(key)}${required?'':'?'}: ${schemaType(value,mode)};`;
    });
    return fields.length?`{ ${fields.join(' ')} }`:'Readonly<Record<string, never>>';
  }
  if(node.type==='array')return `ReadonlyArray<${schemaType(node.items,mode)}>`;
  return node.type==='integer'?'number':node.type;
}
function parameterSchema(command) {
  if(!command.parameters)return null;
  return {schemaVersion:1,schema:{type:'object',additionalProperties:false,properties:Object.fromEntries(command.parameters.map(p=>[p.name,{type:p.type,...(p.choices?{enum:p.choices}:{})}])),required:command.parameters.filter(p=>p.required).map(p=>p.name)}};
}
function jsonSchemaNode(node, bounded=true,mode='output') {
  if(node.format==='dds-secret-reference')return {type:'object',additionalProperties:false,properties:{kind:{const:'dds-secret-reference'},id:{type:'string',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'}},required:['kind','id']};
  const result={};
  for(const [key,value]of Object.entries(node)){
    if(key==='display'){result['x-dds-display']=value;continue;}
    if(key==='properties')result.properties=Object.fromEntries(Object.entries(value).map(([name,item])=>[name,jsonSchemaNode(item,bounded,mode)]));
    else if(key==='items')result.items=jsonSchemaNode(value,bounded,mode);
    else if(key==='required'&&mode==='input')result.required=value.filter(name=>!Object.hasOwn(node.properties[name],'default'));
    else result[key]=value;
  }
  if(bounded&&node.type==='string')result.maxLength=Math.min(result.maxLength??16_384,16_384);
  if(bounded&&node.type==='array')result.maxItems=Math.min(result.maxItems??256,256);
  if(bounded&&node.type==='integer'){result.minimum=Math.max(result.minimum??-Number.MAX_SAFE_INTEGER,-Number.MAX_SAFE_INTEGER);result.maximum=Math.min(result.maximum??Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);}
  return result;
}
/** Pure deterministic generation. Runtime validators remain authoritative for shared budgets. */
export function createGeneratedContracts(manifest, input) {
  manifest=parseManifest(manifest);const definition=parseDevelopmentDefinition(input,manifest),files=new Map();
  const sourceSha256=devHash(stable({manifest,definition}));
  files.set('contracts.json',devJson(definition));
  files.set('contracts.mjs',`// Generated by DDS Plugin SDK ${SDK_VERSION}; do not edit.\nimport definition from './contracts.json' with {type:'json'};\nimport {parseCommandDefinition} from '@altifigence/dds-plugin-sdk';\nimport {parseSettingsDefinition} from '@altifigence/dds-plugin-sdk/settings';\nimport {parseLocaleCatalog} from '@altifigence/dds-plugin-sdk/localization';\nimport {parseTheme} from '@altifigence/dds-plugin-sdk/themes';\nexport const commands=Object.freeze(Object.fromEntries(definition.commands.map(value=>{const command=parseCommandDefinition(value);return [command.id,command];})));\nexport const settingsDefinition=definition.settings?parseSettingsDefinition(definition.settings):null;\nexport const catalog=definition.catalog?parseLocaleCatalog(definition.catalog):null;\nexport const theme=definition.theme?parseTheme(definition.theme):null;\n`);
  const declarations=[`// Generated by DDS Plugin SDK ${SDK_VERSION}; validation constraints remain runtime checks.`,"import type {JsonValue,CommandDefinition} from '@altifigence/dds-plugin-sdk';","import type {SecretReference} from '@altifigence/dds-plugin-sdk/data-schema';","import type {SettingsDefinition} from '@altifigence/dds-plugin-sdk/settings';","import type {LocaleCatalog} from '@altifigence/dds-plugin-sdk/localization';","import type {DdsTheme} from '@altifigence/dds-plugin-sdk/themes';"];
  const maps={CommandInputs:[],ValidatedCommandInputs:[],CommandOutputs:[]};
  for(const command of definition.commands){
    const inputSchema=command.inputSchema??parameterSchema(command),outputSchema=command.outputSchema;
    maps.CommandInputs.push(`readonly ${JSON.stringify(command.id)}: ${inputSchema?schemaType(inputSchema.schema,'input'):'JsonValue'};`);
    maps.ValidatedCommandInputs.push(`readonly ${JSON.stringify(command.id)}: ${inputSchema?schemaType(inputSchema.schema,'validated'):'JsonValue'};`);
    maps.CommandOutputs.push(`readonly ${JSON.stringify(command.id)}: ${outputSchema?schemaType(outputSchema.schema):'JsonValue'};`);
    for(const [kind,schema]of [['input',inputSchema],['output',outputSchema]])if(schema)files.set(`schemas/${command.id}-${kind}.schema.json`,devJson({$schema:'https://json-schema.org/draft/2020-12/schema',$id:`urn:dds:${manifest.id}:${command.id}:${kind}`,title:command.title+' '+kind,...jsonSchemaNode(schema.schema,kind==='output'||!!command.inputSchema,kind)}));
  }
  for(const [name,fields]of Object.entries(maps))declarations.push(`export interface ${name} { ${fields.join(' ')} }`);
  declarations.push('export const commands: Readonly<{ '+definition.commands.map(c=>`readonly ${JSON.stringify(c.id)}: CommandDefinition;`).join(' ')+' }>;');
  declarations.push(`export const settingsDefinition: ${definition.settings?'SettingsDefinition':'null'};`,`export const catalog: ${definition.catalog?'LocaleCatalog':'null'};`,`export const theme: ${definition.theme?'DdsTheme':'null'};`);
  const settings=definition.settings?.settings??{};
  declarations.push('export interface SettingsValues { '+Object.entries(settings).map(([name,item])=>`readonly ${JSON.stringify(name)}${Object.hasOwn(item.schema.schema,'default')?'':'?'}: ${schemaType(item.schema.schema,'validated')};`).join(' ')+' }');
  if(definition.settings)files.set('schemas/settings.schema.json',devJson({$schema:'https://json-schema.org/draft/2020-12/schema',$id:`urn:dds:${manifest.id}:settings`,type:'object',additionalProperties:false,properties:Object.fromEntries(Object.entries(settings).map(([name,item])=>[name,jsonSchemaNode(item.schema.schema)])),required:Object.entries(settings).filter(([,item])=>Object.hasOwn(item.schema.schema,'default')).map(([name])=>name)}));
  if(definition.theme)files.set('theme.xml',serializeThemeXml(definition.theme));
  files.set('contracts.d.mts',declarations.join('\n')+'\n');
  const receipt={schemaVersion:1,sdkVersion:SDK_VERSION,sourceSha256,files:fileInventory(files)};
  receipt.digest=devHash(stable(receipt));files.set('generation.json',devJson(receipt));
  return {definition,files:checkedFiles(files),receipt:freezeConfiguration(receipt)};
}
async function sourceFiles(root){
  const manifestText=await readDevFile(path.join(root,'plugin.json'),65_536),definitionText=await readDevFile(path.join(root,'dds-dev.json'),DEVTOOLS_LIMITS.definitionBytes);
  return {manifest:parseManifest(JSON.parse(manifestText)),definition:JSON.parse(definitionText),bytesHash:devHash(stable([manifestText,definitionText]))};
}
async function previousGeneration(root) {
  const directory=await realDirectory(path.join(root,'generated')),text=await readDevFile(path.join(directory,'generation.json'),131_072),receipt=JSON.parse(text);
  configurationObject(receipt,['schemaVersion','sdkVersion','sourceSha256','files','digest']);
  if(receipt.schemaVersion!==1||typeof receipt.sdkVersion!=='string'||!/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(receipt.sdkVersion)||!Array.isArray(receipt.files)||receipt.files.length>255||!['sourceSha256','digest'].every(key=>/^[0-9a-f]{64}$/.test(receipt[key])))throw devFailure('invalid_generation','Invalid generated receipt');
  const {digest,...body}=receipt;if(devHash(stable(body))!==digest)throw devFailure('conflict','Generated receipt digest is invalid');
  const files=new Map();
  for(const item of receipt.files){
    configurationObject(item,['path','bytes','sha256']);
    if(typeof item.path!=='string'||! /^(?:contracts\.(?:mjs|d\.mts|json)|theme\.xml|schemas\/(?:settings|[a-z][a-z0-9._-]*-(?:input|output))\.schema\.json)$/.test(item.path)||files.has(item.path)||!Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>1_048_576||!/^[a-f0-9]{64}$/.test(item.sha256))throw devFailure('invalid_generation','Invalid generated file receipt');
    const content=await readDevFile(path.join(directory,item.path));
    if(Buffer.byteLength(content)!==item.bytes||devHash(content)!==item.sha256)throw devFailure('conflict','A generated file was edited; preserve and inspect local edits');files.set(item.path,content);
  }
  files.set('generation.json',text);await inspectGeneratedDirectory(directory,files);return {receipt,files};
}
export async function generatePluginContracts(directory,options={}) {
  devOptions(options,['dryRun','check','expectedDigest']);
  for(const key of ['dryRun','check'])if(options[key]!==undefined&&typeof options[key]!=='boolean')throw devFailure('invalid_options','Invalid generation option');
  if(options.dryRun&&options.check)throw devFailure('invalid_options','Choose dryRun or check');
  if(options.expectedDigest!==undefined&&!/^[a-f0-9]{64}$/.test(options.expectedDigest))throw devFailure('invalid_options','Expected a SHA-256 generation digest');
  const root=await realDirectory(directory),source=await sourceFiles(root),generated=createGeneratedContracts(source.manifest,source.definition),target=path.join(root,'generated');
  let previous=null,conflict=null;
  if(await destinationExists(target))try{previous=await previousGeneration(root);}catch(e){conflict=e.code??'invalid_generation';}
  const current=!!previous&&previous.receipt.digest===generated.receipt.digest;
  const report={schemaVersion:1,directory:root,sdkVersion:SDK_VERSION,digest:generated.receipt.digest,previousDigest:previous?.receipt.digest??null,current,written:false,files:fileInventory(generated.files),conflicts:conflict?[conflict]:[]};
  if(options.dryRun)return freezeConfiguration(report);
  if(options.check)return freezeConfiguration({...report,ok:current&&!conflict});
  if(conflict)throw devFailure('conflict','Generated files differ from their receipt; preserve local edits');
  if(current&&options.expectedDigest===undefined)return freezeConfiguration({...report,ok:true});
  if(previous&&options.expectedDigest!==previous.receipt.digest)throw devFailure('conflict','Replacing generated files requires their exact expectedDigest');
  if(!previous&&options.expectedDigest!==undefined)throw devFailure('conflict','No previous generation matches expectedDigest');
  if(current)return freezeConfiguration({...report,ok:true});
  await replaceGeneratedDirectory(root,generated.files,previous?.files,async()=>{if((await sourceFiles(root)).bytesHash!==source.bytesHash)throw devFailure('conflict','Development source changed before generation');});
  return freezeConfiguration({...report,ok:true,current:true,written:true});
}
