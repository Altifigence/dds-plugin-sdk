import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
const number={type:'integer',minimum:0,maximum:10000};
const object=properties=>({schemaVersion:1,schema:{type:'object',properties,required:Object.keys(properties),additionalProperties:false}});
export const scope=Object.freeze({workspaceId:'example',securityScope:'operator'});
export const pluginSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
export const commands=[
  {id:'measure',pluginId:'workflow-example',pluginSha256,inputSchema:object({source:{type:'string',maxLength:180}}),outputSchema:object({value:number}),grants:[]},
  {id:'combine',pluginId:'workflow-example',pluginSha256,inputSchema:object({left:number,right:number}),outputSchema:object({value:number}),grants:[]},
];
const measure=(id,source)=>({id,commandId:'measure',needs:[],input:{source:{value:source}},grants:[]});
export const definition={schemaVersion:1,id:'example-build',scope,steps:[measure('left','left.txt'),measure('right','right.txt'),{id:'sum',commandId:'combine',needs:['left','right'],input:{left:{step:'left',path:['value']},right:{step:'right',path:['value']}},grants:[]}],policy:'continue',concurrency:2,timeoutMs:10000,stepTimeoutMs:5000,retentionMs:60000};
export const recoveryDefinition={...definition,id:'recovery',steps:[measure('left','left.txt'),{...measure('right','right.txt'),needs:['left']}]};
