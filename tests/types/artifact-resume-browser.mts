import {createOpfsArtifactSink,getBrowserArtifactResumeSupport,getOpfsArtifactPartialNames,parseBrowserArtifactCheckpoint} from '@altifigence/dds-plugin-sdk/artifact-resume-browser';
import type {OpfsCheckpointDirectory,BrowserCheckpointLocks,BrowserArtifactCheckpoint} from '@altifigence/dds-plugin-sdk/artifact-resume-browser';
import type {StoredArtifactReference} from '@altifigence/dds-plugin-sdk/artifact-storage';
import {streamStoredJobArtifact} from '@altifigence/dds-plugin-sdk/artifact-transfer';
import type {StoredArtifactClient} from '@altifigence/dds-plugin-sdk/artifact-transfer';
import {createTransferQueue} from '@altifigence/dds-plugin-sdk/transfer-queue';
declare const directory:OpfsCheckpointDirectory,locks:BrowserCheckpointLocks,reference:StoredArtifactReference,client:StoredArtifactClient;
const sink=createOpfsArtifactSink({directory,locks,reference,partialId:'12345678-1234-4234-8234-123456789abc'});
void streamStoredJobArtifact(client,reference,{sink,resume:true,onProgress:p=>{const phase:string=p.phase;void phase;}});
createTransferQueue().enqueueStoredDownload(client,reference,{sink,resume:true});
const checkpoint:BrowserArtifactCheckpoint=parseBrowserArtifactCheckpoint({});void checkpoint;
const supported:boolean=getBrowserArtifactResumeSupport().supported;void supported;
const metadata:string=getOpfsArtifactPartialNames(sink.partialId).metadata;void metadata;
// @ts-expect-error recovery requires a boolean, not inferred truthiness
void streamStoredJobArtifact(client,reference,{sink,resume:'yes'});
