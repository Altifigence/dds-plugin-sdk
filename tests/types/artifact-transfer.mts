import {createIncrementalSha256,streamJobBinaryArtifact,streamStoredJobArtifact,ArtifactTransferError,parseArtifactTransferReceipt,type ArtifactSink,type ArtifactTransferReceipt} from '@altifigence/dds-plugin-sdk/artifact-transfer';
import {createBrowserFileSink,createOpfsFileSink,getBrowserArtifactStorageSupport,type BrowserFileHandle,type BrowserDirectoryHandle} from '@altifigence/dds-plugin-sdk/artifact-transfer-browser';
import type {WorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
import type {BinaryArtifactReference} from '@altifigence/dds-plugin-sdk/artifacts';
import type {StoredArtifactReference} from '@altifigence/dds-plugin-sdk/artifact-storage';
import {SCHEMAS} from '@altifigence/dds-plugin-sdk/schemas';
declare const client:WorkspaceClient,reference:BinaryArtifactReference,stored:StoredArtifactReference,file:BrowserFileHandle,directory:BrowserDirectoryHandle;
const sink:ArtifactSink=createBrowserFileSink(file,{overwrite:false});
const receipt:ArtifactTransferReceipt=await streamJobBinaryArtifact(client,reference,{sink,onProgress:value=>{const verified:boolean=value.verified;void verified;}});
const verification:'received'|'stored'=receipt.verification;
await streamStoredJobArtifact(client,stored,{sink:await createOpfsFileSink(directory,'result.bin',{overwrite:false})});
const error=new ArtifactTransferError('conflict','checksum',{receivedBytes:1,writtenBytes:1,receivedVerified:false,storedVerified:false,commit:'not-committed',disposition:'retained'});
createIncrementalSha256().update(new Uint8Array()).digest();parseArtifactTransferReceipt(receipt);getBrowserArtifactStorageSupport();void verification;void error;
void SCHEMAS['artifact-transfer-receipt'];void SCHEMAS['artifact-sink-capabilities'];
// @ts-expect-error explicit overwrite decision is required
createBrowserFileSink(file,{});
// @ts-expect-error source reference and a caller sink are required
streamJobBinaryArtifact(client,reference,{});
