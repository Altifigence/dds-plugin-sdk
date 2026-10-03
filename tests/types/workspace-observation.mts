import {createWorkspaceClient, createWorkspaceProject, WORKSPACE_OBSERVATION_LIMITS} from '@altifigence/dds-plugin-sdk/workspace-client';
import type {WorkspaceFileChange, WorkspaceJobUpdate, WorkspaceObserver} from '@altifigence/dds-plugin-sdk/workspace-client';
import type {JobSnapshot} from '@altifigence/dds-plugin-sdk/jobs';
const client=createWorkspaceClient({url:'http://127.0.0.1:4777',token:'example-token-01234567890123456789'});
await client.connect();
const project=createWorkspaceProject(client);
const files:WorkspaceObserver<WorkspaceFileChange>=project.watchFiles(['design.sv'],{intervalMs:1000,includeInitial:false});
const jobs:WorkspaceObserver<WorkspaceJobUpdate>=client.watchJob(crypto.randomUUID(),{after:0,timeoutMs:5000});
for await(const change of files){const revision:string|null=change.revision;void revision;break;}
const result:JobSnapshot=await client.waitForJob(crypto.randomUUID());void result;
await jobs.return();void WORKSPACE_OBSERVATION_LIMITS.files;
// @ts-expect-error a path array is required
project.watchFiles('design.sv');
// @ts-expect-error event content is deliberately absent
const content:string=({} as WorkspaceFileChange).content;void content;
project.dispose();client.dispose();
