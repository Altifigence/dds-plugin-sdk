import {createTransferQueue,parseTransferSnapshot,parseTransferQueueOptions,type TransferSnapshot,type TransferHandle} from '@altifigence/dds-plugin-sdk/transfer-queue';
import type {WorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import type {UploadSource,UploadFileOptions,UploadStatus} from '@altifigence/dds-plugin-sdk/uploads';
import type {BinaryArtifactReference} from '@altifigence/dds-plugin-sdk/artifacts';
import type {StoredArtifactReference} from '@altifigence/dds-plugin-sdk/artifact-storage';
import type {ArtifactSink} from '@altifigence/dds-plugin-sdk/artifact-transfer';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';
async function types(client:WorkspaceClient,source:UploadSource,options:UploadFileOptions,reference:BinaryArtifactReference,stored:StoredArtifactReference,sink:ArtifactSink){
  const queue=createTransferQueue({concurrency:2,perConnection:1,bufferBytes:131072,bytesPerSecond:1048576,attempts:3});
  const upload:TransferHandle<UploadStatus>=queue.enqueueUpload(client,source,options,{priority:1});const initial:TransferSnapshot=upload.snapshot;
  const unsubscribe=queue.subscribe(snapshot=>console.log(snapshot.verified,snapshot.retriedBytes));upload.pause();upload.resume();queue.get(upload.id);queue.list();
  await queue.enqueueDownload(client,reference,{sink}).result;await queue.enqueueStoredDownload(client,stored,{sink}).result;upload.cancel();await upload.result;queue.release(upload.id);unsubscribe();queue.inspect();await queue.dispose();
  parseTransferSnapshot(initial);parseTransferQueueOptions({});SCHEMAS['transfer-snapshot'];SCHEMAS['transfer-queue-options'];SCHEMAS['upload-capabilities'];
}
void types;
