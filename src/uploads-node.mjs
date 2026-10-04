import * as fs from 'node:fs/promises';
import {constants as flags} from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {nodeWorkspaceContext} from './node-workspace-context.mjs';
import {nodeWorkspaceIdentity} from './workspace-identity-node.mjs';
import {storageEqual} from './job-storage-validation.mjs';
import {decodeBinaryArtifactData} from './artifacts.mjs';
import {UPLOAD_LIMITS,DEFAULT_UPLOAD_LIMITS,EMPTY_UPLOAD_SHA256,parseUploadLimits,parseUploadIdentity,parseUploadSpec,parseUploadQuery,parseUploadReference,parseUploadStatus,parseUploadChunk,parseUploadCapabilities,uploadUuid} from './uploads.mjs';
import {WorkspaceError,workspaceFailure,exactObject,requireText,requireWorkspacePath,requireUuid,copyWorkspaceJson} from './workspace-values.mjs';
import {sameFile,sameFileState,uploadFileIdentity,matchesUploadFile,uploadFileError,uploadRegular,uploadOptionalStat,readUploadMetadata,hashUploadFile,syncUploadDirectory,writeUploadExclusive} from './upload-files-node.mjs';
export {createNodeUploadSource} from './upload-source-node.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const contained=(root,target)=>{const r=path.relative(root,target);return r===''||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
const fileId=value=>{exactObject(value,['dev','ino']);for(const key of ['dev','ino'])if(typeof value[key]!=='string'||!/^\d{1,32}$/.test(value[key]))throw workspaceFailure('invalid_request','Invalid upload file identity');return value;};
const owner=value=>{exactObject(value,['pid','host','token']);if(!Number.isSafeInteger(value.pid)||value.pid<1)throw workspaceFailure('invalid_request','Invalid upload lock owner');requireText(value.host,256);uploadUuid(value.token);return value;};
const decode=bytes=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
async function realDirectory(directory){const before=await fs.lstat(directory,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink())throw workspaceFailure('unsafe_path','Upload directory must be a real directory');const canonical=await fs.realpath(directory),stat=await fs.lstat(canonical,{bigint:true});if(!sameFile(before,stat))throw workspaceFailure('conflict','Upload directory changed');return{canonical,stat};}

/** Local single-writer staging; current authority is always supplied by the live host. */
export async function createNodeUploadStore(configuration){
  exactObject(configuration,['workspace','scope','directory','principalId','roots','fileSystem','authorize'],['limits','recoverStaleLock']);
  const {workspace,directory,principalId,authorize,recoverStaleLock=false}=configuration,context=nodeWorkspaceContext(workspace),scope=Object.freeze({...configuration.scope});
  if(!['win32','linux'].includes(process.platform)||configuration.fileSystem!=='local')throw workspaceFailure('unsupported','Uploads require a supported local filesystem profile');
  if(!context||typeof context.mutate!=='function'||workspace.capabilities.write!==true)throw workspaceFailure('permission_denied','Uploads require a writable concrete Node workspace');
  exactObject(scope,['projectId','sessionId']);requireUuid(scope.projectId);requireUuid(scope.sessionId);requireText(principalId);
  if(typeof authorize!=='function'||typeof recoverStaleLock!=='boolean'||typeof directory!=='string'||!path.isAbsolute(directory))throw workspaceFailure('invalid_request','Invalid upload store configuration');
  const limits=Object.freeze(parseUploadLimits({...DEFAULT_UPLOAD_LIMITS,...configuration.limits}));
  if(!Array.isArray(configuration.roots)||!configuration.roots.length||configuration.roots.length>limits.roots)throw workspaceFailure('invalid_request','Explicit upload roots are required');
  const roots=Object.freeze([...new Set(configuration.roots.map(root=>requireWorkspacePath(root,true)))]);
  for(const root of roots){const resolved=await context.resolve(root,{allowRoot:true});if(!resolved.stat.isDirectory())throw workspaceFailure('unsafe_path','Upload root must be a directory');}
  const lifetime=new AbortController(),onWorkspaceClose=()=>lifetime.abort(workspaceFailure('disposed','Upload workspace is disposed'));
  context.signal.addEventListener('abort',onWorkspaceClose,{once:true});
  const records=new Map(),orphans=new Map(),currentOwner={pid:process.pid,host:hostname(),token:randomUUID()};
  let root,initial,identity,lockHeld=false,tail=Promise.resolve(),queued=0,closed=false,closing=false,closePromise;
  const metadataPath=id=>path.join(root,id+'.json'),dataPath=id=>path.join(root,id+'.part');
  const rootAllows=file=>roots.some(root=>root===''||file.startsWith(root+'/'));
  async function checkDirectory(){
    const now=await fs.lstat(root,{bigint:true});if(!now.isDirectory()||now.isSymbolicLink()||!sameFile(now,initial)||await fs.realpath(root)!==root)throw workspaceFailure('unsafe_path','Upload directory identity changed');
  }
  async function checkOwned(checkWorkspace=true){
    await checkDirectory();
    const lock=owner(decode(await readUploadMetadata(path.join(root,'.writer.lock'),2048)));
    if(lock.token!==currentOwner.token||lock.pid!==process.pid||lock.host!==hostname())throw workspaceFailure('conflict','Upload writer lock changed');
    if(checkWorkspace)await context.checkRoot();
  }
  function current(signal,expiresAt){
    if(closed||closing)throw workspaceFailure('disposed','Upload store is closed');
    if(lifetime.signal.aborted)throw lifetime.signal.reason;
    if(signal?.aborted)throw signal.reason instanceof WorkspaceError?signal.reason:workspaceFailure('cancelled','Upload operation cancelled');
    if(expiresAt!==undefined&&Date.now()>=expiresAt)throw workspaceFailure('budget_exceeded','Upload operation deadline exceeded');
  }
  function permit(spec){
    if(!rootAllows(spec.path))throw workspaceFailure('permission_denied','Upload target is outside the approved roots');
    const result=authorize(parseUploadSpec(spec));
    if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw workspaceFailure('invalid_request','Upload authority checks must be synchronous');}
    if(result!==true)throw workspaceFailure('permission_denied','Current upload authority is required');
  }
  async function guard(signal,expiresAt,spec){current(signal,expiresAt);if(spec)permit(spec);await checkOwned();current(signal,expiresAt);if(spec)permit(spec);}
  async function run(operation,options={}){
    exactObject(options,[],['signal','timeoutMs']);const {signal,timeoutMs=limits.timeoutMs}=options;
    if(signal!==undefined&&!(signal instanceof AbortSignal)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>limits.timeoutMs)throw workspaceFailure('invalid_request','Invalid upload operation options');
    current(signal);if(queued>=limits.pending)throw workspaceFailure('budget_exceeded','Upload operation queue is full');
    const expiresAt=Date.now()+timeoutMs,previous=tail;let release;tail=new Promise(resolve=>{release=resolve;});queued++;
    try{await previous;await guard(signal,expiresAt);return copyWorkspaceJson(await operation(spec=>guard(signal,expiresAt,spec)));}
    catch(error){throw uploadFileError(error);}
    finally{queued--;release();}
  }
  function envelope(status,publication,dataIdentity){const record={status,publication,dataIdentity};return JSON.stringify({formatVersion:1,record,sha256:digest(JSON.stringify(record))});}
  function parseRecord(bytes){
    const v=decode(bytes);exactObject(v,['formatVersion','record','sha256']);if(v.formatVersion!==1||v.sha256!==digest(JSON.stringify(v.record)))throw workspaceFailure('conflict','Upload checkpoint checksum mismatch');exactObject(v.record,['status','publication','dataIdentity']);
    const status=parseUploadStatus(v.record.status);fileId(v.record.dataIdentity);if(v.record.publication!==null)fileId(v.record.publication);
    if(!storageEqual(status.reference.identity,identity)||v.record.publication!==null&&!['committing','committed','uncertain'].includes(status.state))throw workspaceFailure('conflict','Upload checkpoint identity mismatch');
    return{status,publication:v.record.publication,dataIdentity:v.record.dataIdentity,diskBody:bytes.toString('utf8'),hash:null,stat:null,poisoned:false};
  }
  async function save(record,status,publication=record.publication){
    status=parseUploadStatus(status);const body=envelope(status,publication,record.dataIdentity);
    if(Buffer.byteLength(body)>limits.recordBytes)throw workspaceFailure('budget_exceeded','Upload metadata exceeds its budget');
    await checkOwned();const file=metadataPath(status.reference.spec.uploadId),temporary=path.join(root,`.checkpoint-${identity.storeId}-${randomUUID()}`);let temporaryStat;
    const apply=()=>{record.status=status;record.publication=publication;record.diskBody=body;};
    try{
      await writeUploadExclusive(temporary,body,checkDirectory);temporaryStat=await fs.lstat(temporary,{bigint:true});await checkOwned();
      const existing=await uploadOptionalStat(file);if(!existing&&record.diskBody!==undefined)throw workspaceFailure('conflict','Upload checkpoint disappeared');if(existing){const previous=await readUploadMetadata(file,limits.recordBytes);if(record.diskBody!==undefined&&previous.toString('utf8')!==record.diskBody)throw workspaceFailure('conflict','Upload checkpoint changed outside its writer');}
      await fs.rename(temporary,file);temporaryStat=undefined;apply();await syncUploadDirectory(root);await checkOwned();
    }catch(error){
      // A filesystem error is not proof that rename did not happen. Adopt only the
      // old or this exact new checkpoint; never truncate using an ambiguous offset.
      try{const actual=(await readUploadMetadata(file,limits.recordBytes)).toString('utf8');if(actual===body)apply();else if(actual!==record.diskBody)record.poisoned=true;}catch(readError){if(readError.code!=='ENOENT')record.poisoned=true;}
      throw error;
    }finally{
      if(temporaryStat){await checkOwned(false);const now=await uploadOptionalStat(temporary);if(now){uploadRegular(now,limits.recordBytes);if(!sameFile(now,temporaryStat))throw workspaceFailure('unsafe_path','Upload checkpoint temporary changed');await fs.unlink(temporary);}}
    }
  }
  async function verifyCheckpoint(record){if(record.poisoned)throw workspaceFailure('conflict','Upload checkpoint requires reopening the store');const raw=await readUploadMetadata(metadataPath(record.status.reference.spec.uploadId),limits.recordBytes);if(raw.toString('utf8')!==record.diskBody)throw workspaceFailure('conflict','Upload checkpoint changed outside its writer');}
  async function partStat(record){const stat=await fs.lstat(dataPath(record.status.reference.spec.uploadId),{bigint:true});uploadRegular(stat,limits.fileBytes);if(!matchesUploadFile(stat,record.dataIdentity))throw workspaceFailure('unsafe_path','Upload staging file identity changed');return stat;}
  async function removePart(record){const file=dataPath(record.status.reference.spec.uploadId),stat=await uploadOptionalStat(file);if(!stat)return;await partStat(record);await checkOwned();await fs.unlink(file);await syncUploadDirectory(root);record.hash=null;record.stat=null;}
  async function ensurePrefix(record,check,force=false){
    const s=record.status,file=dataPath(s.reference.spec.uploadId);await check(s.reference.spec);await verifyCheckpoint(record);let before;
    try{before=await partStat(record);}catch(error){if(error.code!=='ENOENT')throw error;await save(record,{...s,state:'corrupt',updatedAt:Date.now()});return false;}
    if(!force&&record.hash&&record.stat&&sameFileState(before,record.stat))return true;
    if(before.size<BigInt(s.offset)){await save(record,{...s,state:'corrupt',updatedAt:Date.now()});return false;}
    const verified=await hashUploadFile(file,limits.fileBytes,()=>check(s.reference.spec),before,s.offset);
    if(verified.sha256!==s.prefixSha256){await save(record,{...s,state:'corrupt',updatedAt:Date.now()});return false;}
    let stat=verified.stat;
    if(stat.size>BigInt(s.offset)){
      const handle=await fs.open(file,flags.O_RDWR|(flags.O_NOFOLLOW??0));
      try{const opened=await handle.stat({bigint:true});if(!sameFileState(opened,stat))throw workspaceFailure('conflict','Upload staging changed');await check(s.reference.spec);await handle.truncate(s.offset);await handle.sync();stat=await handle.stat({bigint:true});uploadRegular(stat,limits.fileBytes);const now=await partStat(record);if(!sameFileState(now,stat))throw workspaceFailure('conflict','Upload staging changed');}
      finally{await handle.close();}
    }
    record.hash=verified.hash;record.stat=stat;return true;
  }
  async function lookup(query,check){
    const record=records.get(query.uploadId);if(!record)throw workspaceFailure('not_found','Upload is unknown');const s=record.status,reference=s.reference;
    if(reference.spec.pluginId!==query.pluginId||reference.spec.artifactSha256!==query.artifactSha256)throw workspaceFailure('plugin_mismatch','Upload belongs to another plugin artifact');await check(reference.spec);await verifyCheckpoint(record);return record;
  }
  function matchReference(record,reference){
    if(reference.scope.projectId!==scope.projectId||reference.scope.sessionId!==scope.sessionId)throw workspaceFailure('generation_mismatch','Upload reference belongs to another connection generation');
    if(!storageEqual(record.status.reference,reference))throw workspaceFailure('conflict','Upload reference identity changed');
  }
  async function expire(record){const s=record.status;if(Date.now()<s.reference.expiresAt||['committed','committing','uncertain','expired'].includes(s.state))return;await save(record,{...s,state:'expired',updatedAt:Date.now()},null);await removePart(record);}
  async function targetState(record,check){
    const spec=record.status.reference.spec;await check(spec);const value=await context.resolve(spec.path,{allowMissing:true});
    if(value.stat){uploadRegular(value.stat,limits.fileBytes);const hashed=await hashUploadFile(value.target,limits.fileBytes,async()=>{await check(spec);const now=await context.resolve(spec.path);if(!sameFile(now.stat,value.stat))throw workspaceFailure('conflict','Upload target changed');},value.stat);return{...value,revision:hashed.sha256};}
    return{...value,revision:null};
  }
  function expectedTarget(record,target){if(target.revision!==record.status.reference.spec.expectedRevision)throw workspaceFailure('conflict','Upload destination revision changed');}
  async function finishCommit(record){
    const s=record.status,ref=s.reference,at=Date.now();await save(record,{...s,state:'committed',updatedAt:at,commitReceipt:{uploadId:ref.spec.uploadId,uploadGeneration:ref.uploadGeneration,path:ref.spec.path,revision:ref.spec.sha256,byteLength:ref.spec.byteLength,committedAt:at,verified:true}});
    await removePart(record);return record.status;
  }
  async function publicationPaths(record){const target=await context.resolve(record.status.reference.spec.path,{allowMissing:true}),parent=await fs.lstat(path.dirname(target.target),{bigint:true});await context.verifyParent(target.target,parent);return{...target,parent,temporary:path.join(path.dirname(target.target),'.dds-write-upload-'+record.status.reference.uploadGeneration)};}
  async function cleanPublication(record,paths,check){
    const stat=await uploadOptionalStat(paths.temporary);if(!stat)return;
    uploadRegular(stat,limits.fileBytes);if(!record.publication||!matchesUploadFile(stat,record.publication))throw workspaceFailure('unsafe_path','Upload publication staging changed');await check(record.status.reference.spec);await context.verifyParent(paths.target,paths.parent);await fs.unlink(paths.temporary);await syncUploadDirectory(path.dirname(paths.target));
  }
  async function recoverCommit(record,check){
    const spec=record.status.reference.spec;await check(spec);const paths=await publicationPaths(record),pub=record.publication;
    if(paths.stat&&pub&&matchesUploadFile(paths.stat,pub)){
      // create-if-absent may crash after link() but before unlinking the staging name.
      if(paths.stat.nlink===2n){const temp=await fs.lstat(paths.temporary,{bigint:true});if(temp.isSymbolicLink()||!sameFile(temp,paths.stat)||temp.nlink!==2n)throw workspaceFailure('unsafe_path','Upload publication link changed');await check(spec);await context.verifyParent(paths.target,paths.parent);await fs.unlink(paths.temporary);await syncUploadDirectory(path.dirname(paths.target));paths.stat=await fs.lstat(paths.target,{bigint:true});}
      uploadRegular(paths.stat,limits.fileBytes);const verified=await hashUploadFile(paths.target,limits.fileBytes,async()=>{await check(spec);await context.verifyParent(paths.target,paths.parent);},paths.stat);
      if(verified.byteLength===spec.byteLength&&verified.sha256===spec.sha256)return finishCommit(record);
    }
    const temp=await uploadOptionalStat(paths.temporary);
    if((!pub&&!temp)||(pub&&temp&&matchesUploadFile(temp,pub)&&temp.nlink===1n)){
      if(temp)await cleanPublication(record,paths,check);await save(record,{...record.status,state:'receiving',updatedAt:Date.now()},null);record.hash=null;record.stat=null;return record.status;
    }
    await save(record,{...record.status,state:'uncertain',updatedAt:Date.now()});return record.status;
  }
  function reservedBytes(){return [...records.values()].filter(r=>['receiving','committing','uncertain','corrupt'].includes(r.status.state)).reduce((sum,r)=>sum+r.status.reference.spec.byteLength,0)+[...orphans.values()].reduce((sum,size)=>sum+size,0);}
  function activeCount(){return [...records.values()].filter(r=>['receiving','committing','uncertain'].includes(r.status.state)).length;}
  async function acquire(){
    const lock=path.join(root,'.writer.lock'),recovery=path.join(root,'.recovery.lock');
    if(await uploadOptionalStat(recovery))throw workspaceFailure('conflict','Upload lock recovery is already in progress');
    try{await writeUploadExclusive(lock,JSON.stringify(currentOwner),checkDirectory);lockHeld=true;}
    catch(error){
      if(error.code!=='EEXIST'||!recoverStaleLock)throw error;const previous=owner(decode(await readUploadMetadata(lock,2048)));
      const dead=value=>{if(value.host!==hostname()||value.pid===process.pid)return false;try{process.kill(value.pid,0);return false;}catch(error){return error.code==='ESRCH';}};
      if(!dead(previous))throw workspaceFailure('conflict','Upload store has a live or unverifiable writer');
      await writeUploadExclusive(recovery,JSON.stringify(currentOwner),checkDirectory);
      try{const confirmed=owner(decode(await readUploadMetadata(lock,2048)));if(confirmed.token!==previous.token||!dead(confirmed))throw workspaceFailure('conflict','Upload writer changed');await checkDirectory();await fs.unlink(lock);await writeUploadExclusive(lock,JSON.stringify(currentOwner),checkDirectory);lockHeld=true;}
      finally{const own=owner(decode(await readUploadMetadata(recovery,2048)));if(own.token!==currentOwner.token)throw workspaceFailure('conflict','Upload recovery owner changed');await fs.unlink(recovery);}
    }
    if(await uploadOptionalStat(recovery))throw workspaceFailure('conflict','Upload lock recovery changed');await syncUploadDirectory(root);
  }
  async function release(){if(!lockHeld)return;await checkOwned(false);await fs.unlink(path.join(root,'.writer.lock'));lockHeld=false;await syncUploadDirectory(root);}
  try{
    const parent=await realDirectory(path.dirname(directory)),requested=path.join(parent.canonical,path.basename(directory));
    if(contained(context.canonical,requested)||contained(requested,context.canonical))throw workspaceFailure('unsafe_path','Upload staging must be outside the workspace');
    try{await fs.mkdir(requested,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    const resolved=await realDirectory(requested);root=resolved.canonical;initial=resolved.stat;if(contained(context.canonical,root)||contained(root,context.canonical))throw workspaceFailure('unsafe_path','Upload staging overlaps the workspace');await acquire();
    const expected={protocolVersion:1,workspaceId:scope.projectId,workspaceIdentity:nodeWorkspaceIdentity(context.canonical,context.initial),principalId},manifest=path.join(root,'store.json');
    if(await uploadOptionalStat(manifest)){identity=parseUploadIdentity(decode(await readUploadMetadata(manifest,2048)));if(Object.keys(expected).some(key=>identity[key]!==expected[key]))throw workspaceFailure('conflict','Upload store belongs to another workspace or principal');}
    else{if((await fs.readdir(root)).some(name=>name!=='.writer.lock'))throw workspaceFailure('conflict','Upload directory contains unrecognized data');identity=parseUploadIdentity({...expected,storeId:randomUUID()});await writeUploadExclusive(manifest,JSON.stringify(identity),checkDirectory);await syncUploadDirectory(root);}
    const names=await fs.readdir(root);if(names.length>limits.records*3+limits.pending+2)throw workspaceFailure('budget_exceeded','Upload store entry budget exceeded');
    const recordNames=names.filter(name=>/^[a-f0-9-]{36}\.json$/.test(name));if(recordNames.length>limits.records)throw workspaceFailure('budget_exceeded','Upload record budget exceeded');
    for(const name of recordNames){const record=parseRecord(await readUploadMetadata(path.join(root,name),limits.recordBytes));if(name!==record.status.reference.spec.uploadId+'.json'||record.status.reference.spec.byteLength>limits.fileBytes)throw workspaceFailure('conflict','Upload record filename or size mismatch');records.set(record.status.reference.spec.uploadId,record);}
    let storedBytes=0;
    for(const name of names){
      if(['store.json','.writer.lock'].includes(name)||recordNames.includes(name))continue;
      const file=path.join(root,name),stat=await fs.lstat(file,{bigint:true});uploadRegular(stat,limits.storeBytes);
      if(/^[a-f0-9-]{36}\.part$/.test(name)){storedBytes+=Number(stat.size);if(!records.has(name.slice(0,-5)))orphans.set(name,Number(stat.size));}
      else if(name.startsWith('.checkpoint-'+identity.storeId+'-'))orphans.set(name,Number(stat.size));
      else throw workspaceFailure('unsafe_path','Unexpected upload store entry');
    }
    if(storedBytes>limits.storeBytes||reservedBytes()>limits.storeBytes||activeCount()>limits.active)throw workspaceFailure('budget_exceeded','Upload store capacity exceeded');await checkOwned();
  }catch(error){context.signal.removeEventListener('abort',onWorkspaceClose);if(lockHeld)await release();throw uploadFileError(error);}
  const api=Object.freeze({
    get identity(){return parseUploadIdentity(identity);},limits,
    capabilities(){return parseUploadCapabilities({protocolVersion:1,enabled:!closed&&!closing&&!lifetime.signal.aborted,scope,identity:closed||closing||lifetime.signal.aborted?null:identity,roots:closed||closing||lifetime.signal.aborted?[]:roots,limits,profile:'local-node-v1'});},
    begin(value,options){const spec=parseUploadSpec(value);return run(async check=>{
      await check(spec);if(spec.byteLength>limits.fileBytes)throw workspaceFailure('budget_exceeded','Upload exceeds file budget');
      const existing=records.get(spec.uploadId);if(existing){await lookup(spec,check);if(!storageEqual(existing.status.reference.spec,spec))throw workspaceFailure('conflict','Upload idempotency key has a different specification');if(existing.status.reference.scope.sessionId!==scope.sessionId)throw workspaceFailure('generation_mismatch','Explicitly recover this upload on the new host');await expire(existing);if(existing.status.state==='receiving')await ensurePrefix(existing,check,true);return existing.status;}
      for(const record of records.values())await expire(record);
      if(records.size>=limits.records||activeCount()>=limits.active||reservedBytes()+spec.byteLength>limits.storeBytes)throw workspaceFailure('budget_exceeded','Upload store capacity exceeded');
      const target=await context.resolve(spec.path,{allowMissing:true});if(target.stat&&!target.stat.isFile())throw workspaceFailure('invalid_request','Upload destination must be a file');if(target.stat)uploadRegular(target.stat,limits.fileBytes);
      const at=Date.now(),reference=parseUploadReference({protocolVersion:1,scope,identity,uploadGeneration:randomUUID(),spec,createdAt:at,expiresAt:at+limits.retentionMs});
      await writeUploadExclusive(dataPath(spec.uploadId),new Uint8Array(),checkDirectory);const stat=await fs.lstat(dataPath(spec.uploadId),{bigint:true});
      const record={status:parseUploadStatus({reference,state:'receiving',offset:0,prefixSha256:EMPTY_UPLOAD_SHA256,updatedAt:at,commitReceipt:null}),publication:null,dataIdentity:uploadFileIdentity(stat),hash:createHash('sha256'),stat,poisoned:false};
      try{await save(record,record.status);records.set(spec.uploadId,record);await check(spec);return record.status;}
      catch(error){if(record.diskBody!==undefined)records.set(spec.uploadId,record);else{await partStat(record);await fs.unlink(dataPath(spec.uploadId));}throw error;}
    },options);},
    query(value,options){const query=parseUploadQuery(value);return run(async check=>{
      const record=await lookup(query,check);if(record.status.reference.scope.sessionId!==scope.sessionId){if(!query.recover)throw workspaceFailure('generation_mismatch','Explicit recovery is required on this host generation');await save(record,{...record.status,reference:{...record.status.reference,scope},updatedAt:Date.now()});}
      if(record.status.state==='committing')await context.mutate(()=>recoverCommit(record,check),options?.signal);await expire(record);if(record.status.state==='receiving')await ensurePrefix(record,check,true);await check(record.status.reference.spec);return record.status;
    },options);},
    write(value,chunkValue,options){const reference=parseUploadReference(value),chunk=parseUploadChunk(chunkValue,reference.spec.byteLength),bytes=Buffer.from(decodeBinaryArtifactData(chunk.data));
      if(digest(bytes)!==chunk.sha256)throw workspaceFailure('conflict','Upload chunk SHA-256 mismatch');
      return run(async check=>{
        const record=await lookup(reference.spec,check);matchReference(record,reference);await expire(record);if(record.status.state!=='receiving')throw workspaceFailure('conflict','Upload is not receiving data');if(bytes.length>limits.chunkBytes)throw workspaceFailure('budget_exceeded','Upload chunk exceeds the host budget');
        if(!await ensurePrefix(record,check))throw workspaceFailure('conflict','Upload prefix is corrupt');const s=record.status;if(chunk.offset>s.offset||chunk.offset<s.offset&&chunk.offset+bytes.length>s.offset)throw workspaceFailure('conflict','Upload chunk overlaps or skips the verified offset');
        const file=dataPath(reference.spec.uploadId),handle=await fs.open(file,flags.O_RDWR|(flags.O_NOFOLLOW??0));
        try{
          const opened=await handle.stat({bigint:true});if(!sameFileState(opened,record.stat))throw workspaceFailure('conflict','Upload staging changed');await check(reference.spec);
          if(chunk.offset<s.offset){const existing=Buffer.alloc(bytes.length);let at=0;while(at<existing.length){const read=await handle.read(existing,at,existing.length-at,chunk.offset+at);if(!read.bytesRead)throw workspaceFailure('conflict','Upload duplicate range changed');at+=read.bytesRead;}if(!existing.equals(bytes))throw workspaceFailure('conflict','Upload duplicate range has different bytes');const after=await handle.stat({bigint:true}),current=await partStat(record);if(!sameFileState(after,opened)||!sameFileState(current,opened))throw workspaceFailure('conflict','Upload staging changed');return s;}
          let written=0;while(written<bytes.length){await check(reference.spec);const result=await handle.write(bytes,written,bytes.length-written,s.offset+written);if(!result.bytesWritten)throw workspaceFailure('unavailable','Upload write did not progress');written+=result.bytesWritten;}
          await handle.sync();const after=await handle.stat({bigint:true}),now=await partStat(record);if(after.size!==BigInt(s.offset+bytes.length)||!sameFileState(after,now)||!sameFile(after,opened))throw workspaceFailure('conflict','Upload staging changed');await check(reference.spec);
          const hash=record.hash.copy().update(bytes),next={...s,offset:s.offset+bytes.length,prefixSha256:hash.copy().digest('hex'),updatedAt:Date.now()};await save(record,next);record.hash=hash;record.stat=after;await check(reference.spec);return record.status;
        }catch(error){record.hash=null;record.stat=null;throw error;}finally{await handle.close();}
      },options);
    },
    commit(value,options){const reference=parseUploadReference(value);return run(async check=>{
      const record=await lookup(reference.spec,check);matchReference(record,reference);if(record.status.state==='committed')return record.status;if(record.status.state==='committing'){await context.mutate(()=>recoverCommit(record,check),options?.signal);if(record.status.state==='committed')return record.status;}
      await expire(record);if(record.status.state!=='receiving')throw workspaceFailure('conflict','Upload cannot be committed');if(!await ensurePrefix(record,check,true))throw workspaceFailure('conflict','Upload prefix is corrupt');
      if(record.status.offset!==reference.spec.byteLength)throw workspaceFailure('conflict','Upload is incomplete');if(record.status.prefixSha256!==reference.spec.sha256){await save(record,{...record.status,state:'corrupt',updatedAt:Date.now()});throw workspaceFailure('conflict','Whole upload SHA-256 mismatch');}
      return context.mutate(async()=>{
        try{
          await check(reference.spec);const target=await targetState(record,check);expectedTarget(record,target);const parent=await fs.lstat(path.dirname(target.target),{bigint:true}),temporary=path.join(path.dirname(target.target),'.dds-write-upload-'+reference.uploadGeneration);
          await save(record,{...record.status,state:'committing',updatedAt:Date.now()},null);await check(reference.spec);await context.verifyParent(target.target,parent);
          const output=await fs.open(temporary,flags.O_WRONLY|flags.O_CREAT|flags.O_EXCL|(flags.O_NOFOLLOW??0),target.stat?Number(target.stat.mode&0o777n):0o600);
          try{
            await save(record,record.status,uploadFileIdentity(await output.stat({bigint:true})));const input=await fs.open(dataPath(reference.spec.uploadId),flags.O_RDONLY|(flags.O_NOFOLLOW??0));
            try{const opened=await input.stat({bigint:true});if(!sameFileState(opened,record.stat))throw workspaceFailure('conflict','Upload staging changed');const buffer=Buffer.alloc(limits.chunkBytes),hash=createHash('sha256');let offset=0;
              while(offset<reference.spec.byteLength){await check(reference.spec);const read=await input.read(buffer,0,Math.min(buffer.length,reference.spec.byteLength-offset),offset);if(!read.bytesRead)throw workspaceFailure('conflict','Upload staging changed');hash.update(buffer.subarray(0,read.bytesRead));let written=0;while(written<read.bytesRead){const result=await output.write(buffer,written,read.bytesRead-written,offset+written);if(!result.bytesWritten)throw workspaceFailure('unavailable','Upload publication did not progress');written+=result.bytesWritten;}offset+=read.bytesRead;}
              if(hash.digest('hex')!==reference.spec.sha256||!sameFileState(await input.stat({bigint:true}),opened)||!sameFileState(await partStat(record),opened))throw workspaceFailure('conflict','Upload source changed during publication');await output.sync();
            }finally{await input.close();}
          }finally{await output.close();}
          const staged=await hashUploadFile(temporary,limits.fileBytes,async()=>{await check(reference.spec);await context.verifyParent(target.target,parent);});
          if(!matchesUploadFile(staged.stat,record.publication)||staged.byteLength!==reference.spec.byteLength||staged.sha256!==reference.spec.sha256)throw workspaceFailure('conflict','Upload publication readback mismatch');
          expectedTarget(record,await targetState(record,check));await context.verifyParent(target.target,parent);await check(reference.spec);
          if(reference.spec.expectedRevision===null){await fs.link(temporary,target.target);const published=await fs.lstat(target.target,{bigint:true}),remaining=await fs.lstat(temporary,{bigint:true});if(published.isSymbolicLink()||!matchesUploadFile(published,record.publication)||!sameFile(published,remaining)||published.nlink!==2n)throw workspaceFailure('conflict','Upload publication changed');await context.verifyParent(target.target,parent);await fs.unlink(temporary);}
          else await fs.rename(temporary,target.target);
          await syncUploadDirectory(path.dirname(target.target));await check(reference.spec);await context.verifyParent(target.target,parent);
          const published=await hashUploadFile(target.target,limits.fileBytes,async()=>{await check(reference.spec);await context.verifyParent(target.target,parent);});
          if(!matchesUploadFile(published.stat,record.publication)||published.byteLength!==reference.spec.byteLength||published.sha256!==reference.spec.sha256)throw workspaceFailure('conflict','Upload committed file readback changed');return await finishCommit(record);
        }catch(error){
          // Keep the durable committing record when authority, IO or cancellation
          // makes publication ambiguous. A later approved query reconciles it.
          throw uploadFileError(error);
        }
      },options?.signal);
    },options);},
    abort(value,options){const reference=parseUploadReference(value);return run(async check=>{
      const record=await lookup(reference.spec,check);matchReference(record,reference);if(record.status.state==='committing')await context.mutate(()=>recoverCommit(record,check),options?.signal);
      if(['committed','uncertain'].includes(record.status.state))return record.status;
      await save(record,{...record.status,state:'aborted',updatedAt:Date.now()},null);await removePart(record);await check(reference.spec);return record.status;
    },options);},
    prune(options){return run(async()=>{
      const removed=[];for(const [id,record]of records){if(Date.now()<record.status.reference.expiresAt||['committing','uncertain'].includes(record.status.state))continue;await verifyCheckpoint(record);await removePart(record);await checkOwned();await fs.unlink(metadataPath(id));records.delete(id);removed.push(id);}await syncUploadDirectory(root);return Object.freeze({removed:Object.freeze(removed),orphans:Object.freeze([...orphans.keys()])});
    },options);},
    inspect(){return Object.freeze({records:records.size,active:activeCount(),reservedBytes:reservedBytes(),pending:queued,orphans:Object.freeze([...orphans.keys()]),closed,revoked:lifetime.signal.aborted,directoryFsync:process.platform!=='win32'});},
    revoke(){if(!lifetime.signal.aborted)lifetime.abort(workspaceFailure('permission_denied','Upload access was revoked'));},
    close(){if(closePromise)return closePromise;closing=true;lifetime.abort(workspaceFailure('disposed','Upload store is closing'));closePromise=(async()=>{await tail;try{await release();}finally{closed=true;context.signal.removeEventListener('abort',onWorkspaceClose);}})();return closePromise;},
  });
  return api;
}
