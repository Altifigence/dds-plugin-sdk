import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import {createWorkspaceServer} from '@altifigence/dds-plugin-sdk/workspace-node';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import {parseJobHistoryQuery,parseJobHistoryPage,type JobHistoryQuery,type JobHistoryPage} from '@altifigence/dds-plugin-sdk/job-history';
import type {JobStore} from '@altifigence/dds-plugin-sdk/job-storage';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';
declare const store:JobStore;
const host=createPluginHost();
const query:JobHistoryQuery={state:'succeeded',disposition:'completed',from:0,limit:16};
const page:JobHistoryPage=host.listJobHistory('example',query);void parseJobHistoryPage(page);void parseJobHistoryQuery(query);
await host.retryCommandJob('example',crypto.randomUUID(),{message:'reviewed'},{jobId:crypto.randomUUID()});
await createWorkspaceServer({root:'/operator/project',workspaceId:crypto.randomUUID(),token:'a'.repeat(64),notice:{id:'test',version:'1',text:'test'},jobs:true,jobStorage:{store}});
const client=createWorkspaceClient({url:'http://127.0.0.1:9000',token:'a'.repeat(64)});
await client.getJobStorageCapabilities();await client.listJobHistory('example','a'.repeat(64),query);
await client.recoverJob('example',crypto.randomUUID(),'a'.repeat(64));
await client.retryCommandJob('example',crypto.randomUUID(),{message:'reviewed'},'a'.repeat(64),{jobId:crypto.randomUUID()});
void SCHEMAS['job-history-query'];void SCHEMAS['job-history-page'];
// @ts-expect-error interrupted is a recovery disposition, not a new v1 state
const invalid:JobHistoryQuery={state:'interrupted'};void invalid;
// @ts-expect-error explicit retry requires new input and a new job ID
await host.retryCommandJob('example',crypto.randomUUID());
