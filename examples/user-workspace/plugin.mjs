import {definePlugin} from '@altifigence/dds-plugin-sdk';

// This module runs only in the operator's workspace server, never in DDS UI.
export default definePlugin({
  manifestVersion:2,id:'example.user-workspace',name:'User workspace example',
  publisher:'example',version:'0.2.0',protocolVersion:1,entry:'./plugin.mjs',
  runtime:'workspace',capabilities:['commands'],
  permissions:['workspace.read','workspace.write','backend.invoke'],
  supportedHosts:['workspace-host'],license:'Apache-2.0',
  source:{visibility:'open',repository:'https://github.com/Altifigence/dds-plugin-sdk',licenseFile:'./LICENSE'},
},ctx=>{
  const pathParameter={name:'path',label:'Project file',type:'string',required:true};
  ctx.registerCommand({id:'inspect',title:'Inspect project file',parameters:[pathParameter]},async(input,{signal})=>{
    const file=await ctx.workspace.readFile(input.path,{signal});
    const tool=await ctx.backends.invoke('module-counter',{content:file.content},{signal});
    return {path:file.path,revision:file.revision,tool};
  });
  ctx.registerCommand({id:'append-note',title:'Append example note',parameters:[pathParameter]},async(input,{signal})=>{
    const file=await ctx.workspace.readFile(input.path,{signal});
    return ctx.workspace.writeFile(file.path,`${file.content}// Edited by a plugin in the user workspace host.\n`,{expectedRevision:file.revision,signal});
  });
  ctx.registerCommand({id:'list',title:'List user workspace files'},(_input,{signal})=>ctx.workspace.listFiles('',{signal}));
});
