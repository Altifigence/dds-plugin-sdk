import {prepareWorkflowPlan,createWorkflowRunner,createCommandJobExecutor,type WorkflowCommand,type WorkflowDefinition,type WorkflowRecord} from '@altifigence/dds-plugin-sdk/workflows';
import {createNodeWorkflowStore} from '@altifigence/dds-plugin-sdk/workflows-node';
import {fingerprintWorkflowInputs,createWorkflowCache,type WorkflowFingerprintInput} from '@altifigence/dds-plugin-sdk/workflow-cache';
import {createNodeWorkflowCacheStore} from '@altifigence/dds-plugin-sdk/workflow-cache-node';
import {createToolStreamParser,createJobToolEventSink,type ToolStreamEvent} from '@altifigence/dds-plugin-sdk/tool-streams';
import {createToolRunner,hashToolFile,type ToolRegistration,type TrustedProcessDefinition} from '@altifigence/dds-plugin-sdk/tool-streams-node';
import {createLspBridge,createLspFrameDecoder,encodeLspMessage,type LspCapabilityMatrix} from '@altifigence/dds-plugin-sdk/lsp-node';
import type {PluginHost,Scope,DocumentSnapshot,LanguageRequest,JobReporter,LanguageResult} from '@altifigence/dds-plugin-sdk';
declare const commands:readonly WorkflowCommand[],definition:WorkflowDefinition,host:PluginHost,scope:Scope,fpInput:WorkflowFingerprintInput,tool:ToolRegistration,process:TrustedProcessDefinition,job:JobReporter,snapshot:DocumentSnapshot,request:LanguageRequest<'completion'>;
const options={directory:'/owner/state',workspaceRoot:'/workspace',scope:definition.scope};
const store=await createNodeWorkflowStore(options);
const runner=createWorkflowRunner({commands,store,authorize:context=>context.grants.length===0,execute:createCommandJobExecutor({resolveHost:({grants,command})=>({host,scope,grants,pluginSha256:command.pluginSha256})})});
const plan=prepareWorkflowPlan(definition,commands);
const record:WorkflowRecord=await runner.run(plan,{approval:{approved:true,planSha256:plan.sha256}});
await runner.recover(record.attemptId);await store.cleanup();store.inspect().directorySynced;await store.close();
const cacheStore=await createNodeWorkflowCacheStore(options),cache=createWorkflowCache({store:cacheStore,authorize:()=>true});
await cache.run(fingerprintWorkflowInputs(fpInput),{compute:()=>({value:1})});await cache.cleanup();await cache.close();await cacheStore.close();
const events:ToolStreamEvent[]=[];
const parser=createToolStreamParser({jobId:'job',commandId:'command',toolId:'tool',toolVersion:'1',onEvent:event=>{events.push(event);}});
await parser.write(new Uint8Array());await parser.finish();parser.dispose();
const tools=createToolRunner({tools:[tool],workspaceRoot:'/workspace',authorize:()=>true});
await tools.run({toolId:'tool',version:'1',input:{},jobId:'job',commandId:'command',onEvent:createJobToolEventSink(job)});await tools.close();await hashToolFile('/operator/tool');
const bridge=await createLspBridge({process,scope,workspaceRoot:'/workspace',authorize:()=>true});
const matrix:LspCapabilityMatrix=bridge.capabilities();matrix.features[0].supported;await bridge.syncDocument(snapshot);
const completion:LanguageResult<'completion'>=await bridge.request<'completion'>(request);completion.data[0].label;
bridge.provider('hover');await bridge.closeDocument(snapshot.uri);await bridge.close();
createLspFrameDecoder().push(encodeLspMessage({jsonrpc:'2.0',id:1,result:null}));
// @ts-expect-error execution requires explicit approval
runner.run(plan,{approval:{approved:false,planSha256:plan.sha256}});
// @ts-expect-error command bindings cannot be both a literal and an output binding
const ambiguous:WorkflowDefinition['steps'][number]['input']={value:{value:1,step:'build',path:[]}};
// @ts-expect-error process approval must be exact true
const unapproved:TrustedProcessDefinition={...process,approved:false};
