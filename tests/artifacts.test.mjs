import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {BINARY_ARTIFACT_LIMITS, parseBinaryArtifact, parseBinaryArtifactCapabilities, parseBinaryArtifactReference, parseBinaryArtifactList, parseBinaryArtifactChunk, parseBinaryArtifactSource, parseBinaryArtifactRange, decodeBinaryArtifactData} from '../src/artifacts.mjs';
import {parseWorkspaceRequest, parseWorkspaceMethodResult} from '../src/workspace-protocol.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const artifact = {id:'trace',path:'outputs/trace.bin',revision:sha(Buffer.from([0,128,255])),byteLength:3};
const reference = {jobId:randomUUID(),scope:{projectId:randomUUID(),sessionId:randomUUID()},artifact};
const chunk = {...reference,offset:0,nextOffset:3,eof:true,data:'AID/',sha256:artifact.revision};

test('binary contracts preserve exact metadata and reject unsafe paths, hooks and oversized identities', () => {
  assert.deepEqual(parseBinaryArtifactReference(reference),reference); assert.ok(Object.isFrozen(parseBinaryArtifactReference(reference).artifact));
  for(const patch of [{path:'../trace.bin'},{path:'.env'},{path:'a/.git/config'},{byteLength:BINARY_ARTIFACT_LIMITS.fileBytes+1},{byteLength:1.2},{revision:'A'.repeat(64)},{mediaType:'text/html'},{id:'bad\nname'}]) assert.throws(()=>parseBinaryArtifact({...artifact,...patch}),{code:'invalid_contract'});
  let calls=0; assert.throws(()=>parseBinaryArtifact({...artifact,get revision(){calls++;return artifact.revision;}})); assert.equal(calls,0);
  assert.throws(()=>parseBinaryArtifactList({...reference,artifacts:[artifact]}));
  assert.throws(()=>parseBinaryArtifactList({jobId:reference.jobId,scope:reference.scope,artifacts:[artifact,artifact]}));
  assert.throws(()=>parseBinaryArtifactSource({path:artifact.path,revision:artifact.revision,byteLength:3,get readChunk(){calls++;return()=>{};}},artifact.path)); assert.equal(calls,0);
});

test('base64 and chunk contracts reject noncanonical encodings, over-allocation, empty non-EOF and inconsistent ranges', () => {
  assert.deepEqual([...decodeBinaryArtifactData(chunk.data)],[0,128,255]); assert.deepEqual(parseBinaryArtifactChunk(chunk),chunk);
  for(const data of ['AID','AID/\n','QR==','A===','====',' '.repeat(4),'A'.repeat(90_000)]) assert.throws(()=>decodeBinaryArtifactData(data),{code:'invalid_contract'});
  for(const patch of [{offset:-1},{nextOffset:2},{eof:false},{data:''},{sha256:'x'.repeat(64)},{extra:true}]) assert.throws(()=>parseBinaryArtifactChunk({...chunk,...patch}),{code:'invalid_contract'});
  assert.throws(()=>parseBinaryArtifactRange(4,1,3)); assert.throws(()=>parseBinaryArtifactRange(0,65_537)); assert.throws(()=>parseBinaryArtifactRange(0,0));
  assert.deepEqual(parseBinaryArtifactRange(3,1,3),{offset:3,length:1});
});

test('optional binary wire methods keep exact parameters and bounded capability negotiation', () => {
  const capabilities={protocolVersion:1,enabled:true,limits:BINARY_ARTIFACT_LIMITS}; assert.deepEqual(parseBinaryArtifactCapabilities(capabilities),capabilities);
  for(const patch of [{fileBytes:0},{chunkBytes:65_537},{artifacts:17},{concurrent:5},{extra:1}]) assert.throws(()=>parseBinaryArtifactCapabilities({...capabilities,limits:{...capabilities.limits,...patch}}));
  const request={version:1,requestId:'binary-read',method:'artifacts.read',workspaceId:reference.scope.projectId,generation:reference.scope.sessionId,params:{jobId:reference.jobId,artifactId:artifact.id,revision:artifact.revision,offset:0,length:3}};
  assert.deepEqual(parseWorkspaceRequest(request),request); assert.deepEqual(parseWorkspaceMethodResult('artifacts.read',chunk),chunk);
  for(const patch of [{path:'/host/file'},{length:0},{offset:-1},{revision:null}]) assert.throws(()=>parseWorkspaceRequest({...request,params:{...request.params,...patch}}),{code:'invalid_request'});
  assert.throws(()=>parseWorkspaceMethodResult('artifacts.read',{...chunk,nextOffset:20}),{code:'invalid_request'});
});
