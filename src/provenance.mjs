import {KeyObject, sign, verify} from 'node:crypto';
import {base64, canonical, clone, digest, exactVersion, fail, fields, sha, sourceUrl, string} from './release-internals.mjs';

const MAX_ARTIFACT=48*1024*1024;
function time(value){if(!Number.isSafeInteger(value)||value<0)fail('INVALID','Expected nonnegative epoch milliseconds');return value;}
function subject(value){fields(value,['name','version','sha256']);string(value.name,'subject',256);exactVersion(value.version);sha(value.sha256);return value;}
function statement(value){
  fields(value,['schemaVersion','subject','publisher','source','issuedAt','expiresAt']);
  if(value.schemaVersion!==1)fail('UNSUPPORTED','Unsupported provenance statement');
  subject(value.subject);string(value.publisher,'publisher',128);
  fields(value.source,['url','revision']);sourceUrl(value.source.url);string(value.source.revision,'source revision',128);
  if(time(value.expiresAt)<=time(value.issuedAt))fail('INVALID','Provenance expiration must follow issue time');
  canonical(value,16384);return clone(value);
}
/** DDS canonical JSON v1: sorted object keys, preserved arrays, finite JSON numbers, UTF-8. */
export function canonicalProvenancePayload(value){return Uint8Array.from(Buffer.from('DDS-PROVENANCE-V1\n'+canonical(statement(value),16384)));}
export function createProvenanceStatement(value){return statement({schemaVersion:1,...value});}
/** The caller owns the key. No release or DDS product signing key is supplied by this SDK. */
export function signPluginProvenance(value,options){
  fields(options,['keyId','privateKey']);string(options.keyId,'key ID',128);
  if(!(options.privateKey instanceof KeyObject)||options.privateKey.type!=='private'||options.privateKey.asymmetricKeyType!=='ed25519')fail('UNSUPPORTED','An Ed25519 private KeyObject is required');
  const payload=statement(value);
  return {schemaVersion:1,algorithm:'Ed25519',keyId:options.keyId,payload,signature:sign(null,canonicalProvenancePayload(payload),options.privateKey).toString('base64')};
}
/** The operator supplies current trust/revocation evidence; verification never fetches it. */
export function verifyPluginProvenance(bytes,envelope,options){
  fields(options,['subject','publisher','trustRoots','now','revocations','maxRevocationAgeMs','offline','allowUnsigned'],['clockSkewMs']);
  subject(options.subject);string(options.publisher,'publisher',128);time(options.now);
  if(!(bytes instanceof Uint8Array)||bytes.byteLength>MAX_ARTIFACT)fail('LIMIT','Invalid artifact byte count');
  if(typeof options.offline!=='boolean'||typeof options.allowUnsigned!=='boolean')fail('INVALID','Explicit offline/unsigned policy required');
  const skew=options.clockSkewMs??0;time(skew);time(options.maxRevocationAgeMs);
  if(skew>300000||options.maxRevocationAgeMs>30*86400000)fail('LIMIT','Trust freshness policy exceeds maximum');
  fields(options.revocations,['observedAt','revokedKeyIds']);time(options.revocations.observedAt);
  if(!Array.isArray(options.revocations.revokedKeyIds)||options.revocations.revokedKeyIds.length>1024)fail('LIMIT','Too many revoked keys');
  for(const key of options.revocations.revokedKeyIds)string(key,'revoked key ID',128);
  if(!Array.isArray(options.trustRoots)||options.trustRoots.length>64)fail('LIMIT','Too many trust roots');
  const keys=new Set();
  for(const root of options.trustRoots){
    fields(root,['keyId','publisher','publicKey','validFrom','validUntil','revokedAt']);string(root.keyId,'key ID',128);string(root.publisher,'publisher',128);
    if(keys.has(root.keyId))fail('INVALID','Duplicate trust root');keys.add(root.keyId);
    if(!(root.publicKey instanceof KeyObject)||root.publicKey.type!=='public'||root.publicKey.asymmetricKeyType!=='ed25519')fail('UNSUPPORTED','An Ed25519 public KeyObject is required');
    if(time(root.validUntil)<=time(root.validFrom))fail('INVALID','Invalid trust-root validity');
    if(root.revokedAt!==null)time(root.revokedAt);
  }
  const checksum=digest(bytes)===options.subject.sha256;
  const result={schemaVersion:1,subject:clone(options.subject),checksum,signature:'unsigned',publisher:'unverified',policy:'rejected',keyId:null,checkedAt:options.now,offline:options.offline,revocationsObservedAt:options.revocations.observedAt,reasons:[],executionAuthorized:false};
  if(!checksum)result.reasons.push('artifact-digest-mismatch');
  if(envelope===null){if(!options.allowUnsigned)result.reasons.push('unsigned-not-allowed');else result.reasons.push('unsigned-explicitly-allowed');result.policy=checksum&&options.allowUnsigned?'accepted':'rejected';return result;}
  fields(envelope,['schemaVersion','algorithm','keyId','payload','signature']);
  if(envelope.schemaVersion!==1||envelope.algorithm!=='Ed25519'){result.signature='unsupported';result.reasons.push('unsupported-envelope');return result;}
  string(envelope.keyId,'key ID',128);result.keyId=envelope.keyId;
  const payload=statement(envelope.payload),sig=base64(envelope.signature,64);
  if(sig.length!==64)fail('INVALID','Ed25519 signature must contain 64 bytes');
  if(canonical(payload.subject)!==canonical(options.subject))result.reasons.push('subject-mismatch');
  if(payload.publisher!==options.publisher)result.reasons.push('publisher-mismatch');
  const root=options.trustRoots.find(r=>r.keyId===envelope.keyId);
  if(!root){result.signature='untrusted-key';result.reasons.push('untrusted-key');return result;}
  result.signature=verify(null,canonicalProvenancePayload(payload),root.publicKey,sig)?'verified':'invalid';
  if(result.signature!=='verified')result.reasons.push('invalid-signature');
  if(root.publisher!==options.publisher||root.publisher!==payload.publisher)result.reasons.push('key-publisher-mismatch');
  else if(result.signature==='verified')result.publisher='verified';
  if(options.now+skew<payload.issuedAt||options.now-skew>=payload.expiresAt)result.reasons.push('statement-time-invalid');
  if(options.now+skew<root.validFrom||options.now-skew>=root.validUntil||payload.issuedAt<root.validFrom||payload.issuedAt>=root.validUntil)result.reasons.push('key-time-invalid');
  if((root.revokedAt!==null&&root.revokedAt<=options.now+skew)||options.revocations.revokedKeyIds.includes(root.keyId))result.reasons.push('key-revoked');
  if(options.revocations.observedAt>options.now+skew||options.now-options.revocations.observedAt>options.maxRevocationAgeMs)result.reasons.push('revocation-evidence-stale');
  if(!result.reasons.length)result.policy='accepted';
  return result;
}
