import {createPluginHost, definePlugin, type PluginManifestV2} from '@altifigence/dds-plugin-sdk';
import {JOB_LIMITS, parseJobSnapshot, type JobReporter} from '@altifigence/dds-plugin-sdk/jobs';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {initPlugin, doctorPlugin, runPluginDev} from '@altifigence/dds-plugin-sdk/devtools';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';
declare const manifest: PluginManifestV2;
const plugin = definePlugin(manifest, context => context.registerCommand({id:'analyze',title:'Analyze'}, async (_, {signal,job}) => {
  if (!job) return null;
  signal.throwIfAborted(); job.reportProgress({completed:1,total:2}); job.log('info','Reading');
  await job.addArtifact({id:'report',path:'report.txt'});
  return job.invokeBackend('analyze',{});
}));
const host=createPluginHost({jobs:true}); void host.activate(plugin);
const current=host.startCommandJob(manifest.id,'analyze',{}, {jobId:crypto.randomUUID()});
if(current.state==='succeeded') {const result=current.result;void result;}
if(current.state==='failed') {const code=current.error.code;void code;}
void host.getJobEvents(current.jobId,0);void host.readJobArtifact(current.jobId,'report');void host.cancelJob(current.jobId);
// @ts-expect-error callers must keep a job ID before sending a start request
host.startCommandJob(manifest.id,'analyze',{},{});
declare const reporter:JobReporter;
// @ts-expect-error only the fixed log levels are supported
reporter.log('trace','text');
// @ts-expect-error absolute executable configuration is not a job reporter API
reporter.spawn('arbitrary');
const client=createWorkspaceClient({url:'https://workspace.example.org',token:'explicit-operator-runtime-value-only'});
void client.getJobCapabilities();void client.startCommandJob(manifest.id,'analyze',{},'a'.repeat(64),{jobId:crypto.randomUUID()});
void client.getJob(current.jobId);void client.getJobEvents(current.jobId,0);void client.cancelJob(current.jobId);void client.readJobArtifact(current.jobId,'report');
void parseJobSnapshot(current);void JOB_LIMITS.operations;void SCHEMAS['job-snapshot'];
void initPlugin('/operator/new-plugin',{id:'my-plugin',publisher:'example'});void doctorPlugin('/operator/plugin');
void runPluginDev('/operator/plugin',{trustLocalCode:true,onEvent(event){if(event.type==='output')void event.text;}});
// @ts-expect-error dev requires explicit local-code trust
void runPluginDev('/operator/plugin',{});
