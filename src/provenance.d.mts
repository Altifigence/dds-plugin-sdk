export interface ProvenanceSubject {readonly name:string;readonly version:string;readonly sha256:string;}
export interface ProvenanceStatement {readonly schemaVersion:1;readonly subject:ProvenanceSubject;readonly publisher:string;readonly source:{readonly url:string;readonly revision:string};readonly issuedAt:number;readonly expiresAt:number;}
/** Node crypto KeyObject; use generateKeyPairSync/createPublicKey in the owning host. */
export interface ProvenanceKey {readonly type:string;readonly asymmetricKeyType?:string;}
export interface ProvenanceEnvelope {readonly schemaVersion:1;readonly algorithm:'Ed25519';readonly keyId:string;readonly payload:ProvenanceStatement;readonly signature:string;}
export interface ProvenanceTrustRoot {readonly keyId:string;readonly publisher:string;readonly publicKey:ProvenanceKey;readonly validFrom:number;readonly validUntil:number;readonly revokedAt:number|null;}
export interface ProvenancePolicy {readonly subject:ProvenanceSubject;readonly publisher:string;readonly trustRoots:readonly ProvenanceTrustRoot[];readonly now:number;readonly revocations:{readonly observedAt:number;readonly revokedKeyIds:readonly string[]};readonly maxRevocationAgeMs:number;readonly offline:boolean;readonly allowUnsigned:boolean;readonly clockSkewMs?:number;}
export interface ProvenanceReceipt {readonly schemaVersion:1;readonly subject:ProvenanceSubject;readonly checksum:boolean;readonly signature:'verified'|'invalid'|'unsigned'|'untrusted-key'|'unsupported';readonly publisher:'verified'|'unverified';readonly policy:'accepted'|'rejected';readonly keyId:string|null;readonly checkedAt:number;readonly offline:boolean;readonly revocationsObservedAt:number;readonly reasons:readonly string[];readonly executionAuthorized:false;}
export function createProvenanceStatement(input:Omit<ProvenanceStatement,'schemaVersion'>):ProvenanceStatement;
export function canonicalProvenancePayload(statement:ProvenanceStatement):Uint8Array;
export function signPluginProvenance(statement:ProvenanceStatement,options:{readonly keyId:string;readonly privateKey:ProvenanceKey}):ProvenanceEnvelope;
export function verifyPluginProvenance(bytes:Uint8Array,envelope:ProvenanceEnvelope|null,options:ProvenancePolicy):ProvenanceReceipt;
