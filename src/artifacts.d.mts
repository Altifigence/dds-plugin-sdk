import type {Scope, RequestOptions} from './index.mjs';

export const BINARY_ARTIFACT_LIMITS: Readonly<{fileBytes:1073741824;chunkBytes:65536;artifacts:16;concurrent:4}>;
export interface BinaryArtifact {readonly id:string;readonly path:string;readonly revision:string;readonly byteLength:number;readonly label?:string;}
export interface BinaryArtifactReference {readonly jobId:string;readonly scope:Scope;readonly artifact:BinaryArtifact;}
export interface BinaryArtifactList {readonly jobId:string;readonly scope:Scope;readonly artifacts:readonly BinaryArtifact[];}
export interface BinaryArtifactCapabilities {readonly protocolVersion:1;readonly enabled:boolean;readonly limits:Readonly<{fileBytes:number;chunkBytes:number;artifacts:number;concurrent:number}>;}
export interface BinaryChunk {readonly offset:number;readonly nextOffset:number;readonly eof:boolean;readonly data:string;readonly sha256:string;}
export interface BinaryArtifactChunk extends BinaryArtifactReference, BinaryChunk {}
export interface BinaryArtifactSource {readonly path:string;readonly revision:string;readonly byteLength:number;readChunk(offset:number,length:number,options?:RequestOptions):Promise<BinaryChunk>;}
export function parseBinaryArtifact(value:unknown):BinaryArtifact;
export function parseBinaryArtifactReference(value:unknown):BinaryArtifactReference;
export function parseBinaryArtifactList(value:unknown):BinaryArtifactList;
export function parseBinaryArtifactCapabilities(value:unknown):BinaryArtifactCapabilities;
export function parseBinaryArtifactRange(offset:number,length:number,byteLength?:number):Readonly<{offset:number;length:number}>;
export function parseBinaryChunk(value:unknown,byteLength?:number):BinaryChunk;
export function parseBinaryArtifactChunk(value:unknown):BinaryArtifactChunk;
export function parseBinaryArtifactSource(value:unknown,expectedPath:string):BinaryArtifactSource;
/** Decodes a bounded canonical base64 chunk; whole-file verification is separate. */
export function decodeBinaryArtifactData(value:string):Uint8Array;
