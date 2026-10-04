import {createPluginHost} from '@altifigence/dds-plugin-sdk';
import {createNodeJobStore, type NodeJobStore} from '@altifigence/dds-plugin-sdk/job-storage-node';
import {parseStoredJob, parseJobRecovery, type StoredJob, type JobStore, type JobRecovery} from '@altifigence/dds-plugin-sdk/job-storage';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';

const store:NodeJobStore=await createNodeJobStore({directory:'/operator/job-store',workspaceRoot:'/operator/project',workspaceId:crypto.randomUUID()});
const generic:JobStore=store;void generic;
const host=createPluginHost({jobs:true,scope:{projectId:store.identity.workspaceId,sessionId:crypto.randomUUID()},grants:['workspace.read'],jobStorage:{store,workspaceIdentity:store.identity.workspaceIdentity,pluginArtifacts:{example:'a'.repeat(64)},redact:entry=>entry.kind==='result'?null:'reviewed'}});
void host.jobStorageCapabilities();await host.flushJobStore();
const recovery:JobRecovery=host.recoverJob('example',crypto.randomUUID());
if(recovery.disposition==='completed') {const record:StoredJob=recovery.record;void parseStoredJob(record);void record.events;}
if(recovery.disposition==='missing') {const empty:null=recovery.record;void empty;}
void parseJobRecovery(recovery);void SCHEMAS['stored-job'];void SCHEMAS['job-recovery'];
declare const record:StoredJob;
await store.write(record,0);void store.has(record.snapshot.jobId);void store.entries();
const release=store.pin(record.snapshot.jobId);release();await store.remove(record.snapshot.jobId,record.revision);await store.prune();void store.inspect();
// @ts-expect-error storage cannot be configured without a current workspace identity
createPluginHost({jobs:true,jobStorage:{store,pluginArtifacts:{example:'a'.repeat(64)}}});
// @ts-expect-error snapshots remain the original v1 state contract
const invented:StoredJob={...record,snapshot:{...record.snapshot,state:'interrupted'}};void invented;
// @ts-expect-error a store mutation requires the exact prior revision
await store.write(record);
host.dispose();await host.flushJobStore();await store.close();
