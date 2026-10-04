import * as fs from 'node:fs/promises';
import {constants as flags} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createPluginHost} from './index.mjs';
import {SDK_VERSION} from './version.mjs';
import {JOB_LIMITS} from './jobs.mjs';
import {BINARY_ARTIFACT_LIMITS, parseBinaryArtifactRange} from './artifacts.mjs';
import {JOB_STORE_LIMITS} from './job-storage.mjs';
import {storageObject} from './job-storage-validation.mjs';
import {nodeWorkspaceIdentity} from './workspace-identity-node.mjs';
import {registerNodeWorkspace} from './node-workspace-context.mjs';
import {createWorkspaceProjectTransport} from './workspace-project-node.mjs';
import {createWorkspaceUploadTransport} from './workspace-upload-node.mjs';
import {ARTIFACT_STORE_LIMITS} from './artifact-storage.mjs';
export {downloadJobBinaryArtifact} from './artifact-download-node.mjs';
export {downloadStoredJobArtifact} from './stored-artifact-download-node.mjs';
import {WORKSPACE_PATH, WORKSPACE_LIMITS, WORKSPACE_ERROR_CODES, WorkspaceError, workspaceFailure, requireText, requireUuid, requireSha256, requireToken, requireWorkspacePath, requireFileContent, copyWorkspaceJson, parseWorkspaceRequest, parseWorkspaceHello, parseWorkspaceMethodResult} from './workspace-protocol.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const aborted = signal => { if (signal?.aborted) throw signal.reason instanceof WorkspaceError ? signal.reason : workspaceFailure('cancelled', 'Workspace operation cancelled'); };
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameBytesState = (a, b) => sameIdentity(a,b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const requireSingleLink = stat => { if (stat.nlink !== 1n) throw workspaceFailure('unsafe_path', 'Hardlinked workspace files are forbidden'); };
const contained = (root, target) => target === root || !path.relative(root, target).startsWith(`..${path.sep}`) && path.relative(root, target) !== '..' && !path.isAbsolute(path.relative(root, target));
function fileError(failure) {
  if (failure instanceof WorkspaceError) return failure;
  if (failure?.code === 'ENOENT') return workspaceFailure('not_found', 'Workspace entry does not exist');
  if (['EEXIST','ENOTEMPTY'].includes(failure?.code)) return workspaceFailure('conflict', 'Workspace destination already exists or is not empty');
  if (['EACCES','EPERM'].includes(failure?.code)) return workspaceFailure('permission_denied', 'Workspace operation denied');
  return workspaceFailure('unavailable', 'Workspace operation failed');
}

/** User-owned UTF-8 workspace. API paths never select an absolute host root. */
export async function createNodeWorkspace({root, writable = true, manage = writable, binaryArtifacts = false} = {}) {
  if (typeof writable !== 'boolean' || typeof manage !== 'boolean' || typeof binaryArtifacts !== 'boolean') throw workspaceFailure('invalid_request', 'Invalid workspace capabilities');
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw workspaceFailure('invalid_request', 'An absolute operator workspace root is required');
  const supplied = await fs.lstat(root, {bigint: true});
  if (supplied.isSymbolicLink() || !supplied.isDirectory()) throw workspaceFailure('unsafe_path', 'Workspace root must be a real directory');
  const canonical = await fs.realpath(root), initial = await fs.lstat(canonical, {bigint: true});
  let closed = false, queued = 0, binaryOperations = 0, tail = Promise.resolve();
  const lifetime = new AbortController();
  async function checkRoot() {
    if (closed) throw workspaceFailure('disposed', 'Workspace is disposed');
    const now = await fs.lstat(canonical, {bigint: true});
    if (now.isSymbolicLink() || !now.isDirectory() || !sameIdentity(now, initial) || await fs.realpath(canonical) !== canonical) throw workspaceFailure('unsafe_path', 'Workspace root identity changed');
  }
  async function resolve(relative, {allowRoot = false, allowMissing = false} = {}) {
    requireWorkspacePath(relative, allowRoot); await checkRoot();
    let target = canonical;
    const parts = relative ? relative.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]);
      let stat;
      try { stat = await fs.lstat(target, {bigint: true}); }
      catch (failure) { if (allowMissing && i === parts.length - 1 && failure.code === 'ENOENT') return {target, stat: undefined}; throw failure; }
      if (stat.isSymbolicLink() || !contained(canonical, await fs.realpath(target))) throw workspaceFailure('unsafe_path', 'Symlink workspace paths are forbidden');
      if (i < parts.length - 1 && !stat.isDirectory()) throw workspaceFailure('unsafe_path', 'Workspace parent is not a directory');
    }
    return {target, stat: await fs.lstat(target, {bigint: true})};
  }
  async function rawRead(relative, signal) {
    aborted(signal);
    const {target, stat} = await resolve(relative);
    if (!stat.isFile()) throw workspaceFailure('invalid_request', 'Expected a regular workspace file');
    requireSingleLink(stat);
    if (stat.size > BigInt(WORKSPACE_LIMITS.fileBytes)) throw workspaceFailure('budget_exceeded', 'File content limit exceeded');
    const handle = await fs.open(target, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({bigint: true});
      if (!sameIdentity(opened, stat) || !opened.isFile()) throw workspaceFailure('conflict', 'Workspace file changed during read');
      requireSingleLink(opened);
      const chunks = []; let total = 0;
      for (;;) {
        aborted(signal); const chunk = Buffer.allocUnsafe(Math.min(16_384, WORKSPACE_LIMITS.fileBytes + 1 - total));
        const {bytesRead} = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > WORKSPACE_LIMITS.fileBytes) throw workspaceFailure('budget_exceeded', 'File content limit exceeded');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const after = await handle.stat({bigint: true}), current = await fs.lstat(target, {bigint: true});
      if (!sameBytesState(opened, after) || current.isSymbolicLink() || !sameIdentity(opened, current)) throw workspaceFailure('conflict', 'Workspace file changed during read');
      requireSingleLink(after); requireSingleLink(current);
      await checkRoot(); aborted(signal);
      const bytes = Buffer.concat(chunks);
      let content; try { content = new TextDecoder('utf-8', {fatal: true}).decode(bytes); } catch { throw workspaceFailure('invalid_request', 'Workspace file must be valid UTF-8'); }
      return {path: relative, content, revision: sha256(bytes), stat: opened};
    } finally { await handle.close(); }
  }
  async function mutate(operation, signal) {
    if (!writable) throw workspaceFailure('permission_denied', 'Workspace is read-only');
    if (queued >= WORKSPACE_LIMITS.pending) throw workspaceFailure('budget_exceeded', 'Workspace mutation queue limit exceeded');
    queued++; const previous = tail; let release; tail = new Promise(resolve => {release = resolve;});
    try { await previous; aborted(signal); await checkRoot(); return await operation(); }
    catch (failure) { throw fileError(failure); }
    finally { queued--; release(); }
  }
  async function binaryOperation(operation) {
    if (!binaryArtifacts) throw workspaceFailure('unsupported', 'Binary artifacts are disabled');
    if (binaryOperations >= BINARY_ARTIFACT_LIMITS.concurrent) throw workspaceFailure('budget_exceeded', 'Binary read capacity exceeded');
    binaryOperations++;
    try {await checkRoot(); return await operation();}
    catch (failure) {throw fileError(failure);}
    finally {binaryOperations--;}
  }
  async function openBinary(relative, expected) {
    const {target, stat} = await resolve(relative);
    if (!stat.isFile()) throw workspaceFailure('invalid_request', 'Expected a regular artifact file');
    requireSingleLink(stat);
    if (stat.size > BigInt(BINARY_ARTIFACT_LIMITS.fileBytes)) throw workspaceFailure('budget_exceeded', 'Binary artifact size limit exceeded');
    if (expected && !sameBytesState(stat, expected)) throw workspaceFailure('conflict', 'Binary artifact changed');
    const handle = await fs.open(target, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({bigint: true}); requireSingleLink(opened);
      if (!opened.isFile() || !sameBytesState(stat, opened)) throw workspaceFailure('conflict', 'Binary artifact changed');
      return {handle, opened};
    } catch (failure) {await handle.close(); throw failure;}
  }
  async function verifyBinary(relative, handle, expected, signal) {
    const after = await handle.stat({bigint: true}), current = await resolve(relative);
    requireSingleLink(after); requireSingleLink(current.stat);
    if (!sameBytesState(after, expected) || !sameBytesState(current.stat, expected)) throw workspaceFailure('conflict', 'Binary artifact changed');
    aborted(signal);
  }
  const requireManage = () => { if (!manage || !writable) throw workspaceFailure('permission_denied', 'Workspace management is disabled'); };
  async function verifyParent(target, expected) {
    await checkRoot(); const parent = path.dirname(target), current = await fs.lstat(parent, {bigint:true});
    if (current.isSymbolicLink() || !sameIdentity(current,expected) || !contained(canonical,await fs.realpath(parent))) throw workspaceFailure('unsafe_path','Workspace parent identity changed');
  }
  const workspace = Object.freeze({
    capabilities: Object.freeze({read: true, write: !!writable, manage: !!writable && !!manage}),
    async listFiles(relative = '', {signal} = {}) {
      try {
        aborted(signal); const {target, stat} = await resolve(relative, {allowRoot:true});
        if (!stat.isDirectory()) throw workspaceFailure('invalid_request','Expected a workspace directory');
        const entries = [], directory = await fs.opendir(target); let visits = 0;
        try {
          for await (const entry of directory) {
            aborted(signal); if (++visits > 10_000) throw workspaceFailure('budget_exceeded','Directory traversal limit exceeded');
            const filePath = relative ? `${relative}/${entry.name}` : entry.name;
            try {requireWorkspacePath(filePath);} catch {continue;}
            if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) continue;
            const verified = await resolve(filePath);
            if (!verified.stat.isFile() && !verified.stat.isDirectory()) continue;
            if (verified.stat.isFile() && verified.stat.nlink !== 1n) continue;
            entries.push({path:filePath,name:entry.name,kind:verified.stat.isDirectory()?'directory':'file',...(verified.stat.isFile()?{size:Number(verified.stat.size)}:{})});
            if (entries.length > WORKSPACE_LIMITS.entries) throw workspaceFailure('budget_exceeded','Directory entry limit exceeded');
          }
        } finally { try {await directory.close();} catch(failure){if(failure.code!=='ERR_DIR_CLOSED')throw failure;} }
        const after = await resolve(relative,{allowRoot:true}); if(!sameIdentity(stat,after.stat))throw workspaceFailure('conflict','Workspace directory changed during listing');
        return Object.freeze(entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(entry=>Object.freeze(entry)));
      } catch(failure){throw fileError(failure);}
    },
    async readFile(relative, {signal} = {}) {try {const {stat:_,...result}=await rawRead(relative,signal);return Object.freeze(result);}catch(failure){throw fileError(failure);}},
    ...(binaryArtifacts ? {captureBinaryFile(relative, {signal} = {}) {
      return binaryOperation(async () => {
        aborted(signal); const {handle, opened} = await openBinary(relative);
        let revision;
        try {
          const hash = createHash('sha256'), buffer = Buffer.alloc(BINARY_ARTIFACT_LIMITS.chunkBytes); let offset = 0;
          for (;;) {
            aborted(signal); const {bytesRead} = await handle.read(buffer, 0, buffer.length, offset);
            if (!bytesRead) break;
            offset += bytesRead;
            if (offset > BINARY_ARTIFACT_LIMITS.fileBytes) throw workspaceFailure('budget_exceeded', 'Binary artifact size limit exceeded');
            hash.update(buffer.subarray(0, bytesRead));
          }
          if (BigInt(offset) !== opened.size) throw workspaceFailure('conflict', 'Binary artifact changed');
          await verifyBinary(relative, handle, opened, signal); revision = hash.digest('hex');
        } finally {await handle.close();}
        const byteLength = Number(opened.size);
        return Object.freeze({path: relative, revision, byteLength,
          readChunk(offset, length, {signal: readSignal} = {}) {
            return binaryOperation(async () => {
              try {parseBinaryArtifactRange(offset, length, byteLength);} catch {throw workspaceFailure('invalid_request', 'Invalid artifact range');}
              aborted(readSignal); const {handle: chunkHandle} = await openBinary(relative, opened);
              try {
                const bytes = Buffer.alloc(Math.min(length, byteLength - offset)); let received = 0;
                while (received < bytes.length) {
                  aborted(readSignal); const {bytesRead} = await chunkHandle.read(bytes, received, bytes.length - received, offset + received);
                  if (!bytesRead) throw workspaceFailure('conflict', 'Binary artifact changed'); received += bytesRead;
                }
                await verifyBinary(relative, chunkHandle, opened, readSignal);
                return Object.freeze({offset, nextOffset: offset + received, eof: offset + received === byteLength, data: bytes.toString('base64'), sha256: sha256(bytes)});
              } finally {await chunkHandle.close();}
            });
          },
        });
      });
    }} : {}),
    async writeFile(relative, content, {expectedRevision,signal} = {}) {
      requireWorkspacePath(relative);requireFileContent(content);if(expectedRevision!==null)requireSha256(expectedRevision);
      return mutate(async()=>{
        const {target,stat}=await resolve(relative,{allowMissing:true});
        const parent=await fs.lstat(path.dirname(target),{bigint:true});
        if(stat&&!stat.isFile())throw workspaceFailure('invalid_request','Expected a regular workspace file');
        if(stat)requireSingleLink(stat);
        if(expectedRevision===null&&stat||expectedRevision!==null&&!stat)throw workspaceFailure('conflict','The file revision changed');
        if(stat&&(await rawRead(relative,signal)).revision!==expectedRevision)throw workspaceFailure('conflict','The file revision changed');
        const temporary=path.join(path.dirname(target),`.dds-write-${randomUUID()}`), bytes=Buffer.from(content,'utf8');
        let handle;
        try {
          handle=await fs.open(temporary,flags.O_WRONLY|flags.O_CREAT|flags.O_EXCL|(flags.O_NOFOLLOW??0),stat?Number(stat.mode&0o777n):0o600);
          await handle.writeFile(bytes);await handle.sync();await handle.close();handle=undefined;
          aborted(signal);await verifyParent(target,parent);
          if(stat){if((await rawRead(relative,signal)).revision!==expectedRevision)throw workspaceFailure('conflict','The file revision changed');await fs.rename(temporary,target);}
          else {await fs.link(temporary,target);await fs.unlink(temporary);}
          return Object.freeze({path:relative,revision:sha256(bytes)});
        } finally {if(handle)await handle.close().catch(()=>{});await fs.unlink(temporary).catch(failure=>{if(failure.code!=='ENOENT')throw failure;});}
      },signal);
    },
    async mkdir(relative,{signal}={}) {
      requireManage();return mutate(async()=>{const {target,stat}=await resolve(relative,{allowMissing:true});if(stat)throw workspaceFailure('conflict','Workspace destination already exists');const parent=await fs.lstat(path.dirname(target),{bigint:true});await verifyParent(target,parent);aborted(signal);await fs.mkdir(target,{mode:0o755});return Object.freeze({path:relative});},signal);
    },
    async rename(relative,newPath,{expectedRevision,signal}={}) {
      requireManage();requireWorkspacePath(newPath);if(expectedRevision!==undefined)requireSha256(expectedRevision);
      return mutate(async()=>{
        const source=await resolve(relative),destination=await resolve(newPath,{allowMissing:true});
        if(destination.stat)throw workspaceFailure('conflict','Workspace destination already exists');
        // Exclusive hardlink publication gives regular files a portable no-overwrite guarantee.
        if(!source.stat.isFile())throw workspaceFailure('unsupported','Renaming directories is not supported');
        const before=await rawRead(relative,signal);if(expectedRevision!==undefined&&before.revision!==expectedRevision)throw workspaceFailure('conflict','The file revision changed');
        const parent=await fs.lstat(path.dirname(destination.target),{bigint:true});await verifyParent(destination.target,parent);aborted(signal);
        await fs.link(source.target,destination.target);
        try {const current=await fs.lstat(source.target,{bigint:true});if(current.isSymbolicLink()||!sameIdentity(current,source.stat)||current.nlink!==2n)throw workspaceFailure('conflict','Workspace file identity changed');await fs.unlink(source.target);}
        catch(failure){await fs.unlink(destination.target).catch(()=>{});throw failure;}
        return Object.freeze({path:relative,newPath});
      },signal);
    },
    async remove(relative,{expectedRevision,signal}={}) {
      requireManage();if(expectedRevision!==undefined)requireSha256(expectedRevision);
      return mutate(async()=>{const entry=await resolve(relative);if(entry.stat.isFile()){requireSingleLink(entry.stat);if(expectedRevision!==undefined&&(await rawRead(relative,signal)).revision!==expectedRevision)throw workspaceFailure('conflict','The file revision changed');aborted(signal);await fs.unlink(entry.target);}else if(entry.stat.isDirectory()){if(expectedRevision!==undefined)throw workspaceFailure('invalid_request','Directory removal has no file revision');aborted(signal);await fs.rmdir(entry.target);}else throw workspaceFailure('unsupported','Unsupported workspace entry');return Object.freeze({path:relative});},signal);
    },
    dispose(){if(closed)return;closed=true;lifetime.abort(workspaceFailure('disposed','Workspace is disposed'));},
  });
  registerNodeWorkspace(workspace, {canonical, initial, resolve, checkRoot, rawRead, mutate, verifyParent, signal:lifetime.signal});
  return workspace;
}

/** Operator-pinned executable/arguments. No request-controlled shell or command line. */
export function createProcessBackend({executable,args=[],cwd,env={},timeoutMs=WORKSPACE_LIMITS.defaultTimeoutMs,maxOutputBytes=WORKSPACE_LIMITS.jsonBytes}={}) {
  if(typeof executable!=='string'||!path.isAbsolute(executable)||typeof cwd!=='string'||!path.isAbsolute(cwd)||!Array.isArray(args)||args.length>64||args.some(arg=>typeof arg!=='string'||arg.length>4096||arg.includes('\0')))throw workspaceFailure('invalid_request','An absolute executable and workspace cwd are required');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>JOB_LIMITS.maxTimeoutMs||!Number.isInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>WORKSPACE_LIMITS.jsonBytes)throw workspaceFailure('invalid_request','Invalid tool execution budget');
  const environment={};
  for(const [key,value]of Object.entries(env)){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||typeof value!=='string'||value.includes('\0')||value.length>4096)throw workspaceFailure('invalid_request','Invalid tool environment');environment[key]=value;}
  args=Object.freeze([...args]);Object.freeze(environment);
  return async(input,{signal}={})=>{
    aborted(signal);const json=JSON.stringify(copyWorkspaceJson(input));
    const child=spawn(executable,args,{cwd,env:environment,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    return new Promise((resolve,reject)=>{
      let settled=false,bytes=0,stderrBytes=0,output=[];
      const stop=()=>new Promise(resolveStop=>{
        if(child.exitCode!==null||child.signalCode!==null){resolveStop();return;}
        let stopTimer;
        const stopped=()=>{clearTimeout(stopTimer);child.off('close',stopped);resolveStop();};
        child.once('close',stopped);stopTimer=setTimeout(stopped,1_500);
        if(process.platform==='win32'){
          if(child.pid){const systemRoot=process.env.SystemRoot||'C:\\Windows';const killer=spawn(path.join(systemRoot,'System32','taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,shell:false,stdio:'ignore',env:{SystemRoot:systemRoot}});const killerTimer=setTimeout(()=>{killer.kill();child.kill();},1_000);killer.on('error',()=>{clearTimeout(killerTimer);child.kill();});killer.on('close',()=>clearTimeout(killerTimer));}else stopped();
        }else if(child.pid){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
      });
      const finish=(failure,result)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);if(failure){void stop().then(()=>reject(failure));}else resolve(result);};
      const onAbort=()=>finish(workspaceFailure('cancelled','Tool execution cancelled'));
      const timer=setTimeout(()=>finish(workspaceFailure('budget_exceeded','Tool execution timed out')),timeoutMs);
      signal?.addEventListener('abort',onAbort,{once:true});
      child.on('error',()=>finish(workspaceFailure('provider_failed','Configured tool could not start')));
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)finish(workspaceFailure('budget_exceeded','Tool output limit exceeded'));else output.push(chunk);});
      child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>maxOutputBytes)finish(workspaceFailure('budget_exceeded','Tool output limit exceeded'));});
      child.stdin.on('error',()=>{});child.stdin.end(json);
      child.on('close',code=>{
        if(settled)return;
        if(code!==0){finish(workspaceFailure('provider_failed','Configured tool failed'));return;}
        try{const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(output));finish(undefined,copyWorkspaceJson(JSON.parse(text)));}
        catch{finish(workspaceFailure('provider_failed','Configured tool returned invalid JSON'));}
      });
      if(signal?.aborted)onAbort();
    });
  };
}

function safeOperationFailure(failure) {
  const descriptor=failure&&typeof failure==='object'?Object.getOwnPropertyDescriptor(failure,'code'):undefined;
  const supplied=descriptor&&'value'in descriptor?descriptor.value:undefined;
  if(failure instanceof WorkspaceError)return workspaceFailure(supplied,`Workspace operation failed (${WORKSPACE_ERROR_CODES.includes(supplied)?supplied:'invalid_request'})`);
  const map={invalid_contract:'invalid_request',permission_denied:'permission_denied',cancelled:'cancelled',budget_exceeded:'budget_exceeded',disposed:'disposed',conflict:'conflict',capability_unavailable:'unavailable',provider_unavailable:'unavailable'};
  const code=map[supplied]??'provider_failed';
  return workspaceFailure(code,'Workspace operation failed');
}

/** HTTP server for explicitly configured trusted plugins in the user environment. */
export async function createWorkspaceServer({workspace,root,workspaceId,name='User workspace',token,plugins=[],pluginHost,grants=[],backends={},jobs=false,binaryArtifacts=false,jobStorage,projects,uploads,notice,host='127.0.0.1',port=0,writable=true,manage=writable,allowedOrigins=[],timeoutMs=WORKSPACE_LIMITS.defaultTimeoutMs}={}) {
  requireUuid(workspaceId);requireText(name,128);requireText(host,253);token=requireToken(token);
  if(typeof jobs!=='boolean'||typeof binaryArtifacts!=='boolean')throw workspaceFailure('invalid_request','Invalid job capability');
  const ownsPluginHost=pluginHost===undefined;
  if(uploads!==undefined&&(workspace!==undefined||!ownsPluginHost))throw workspaceFailure('invalid_request','Uploads require a server-owned Node workspace and plugin host');
  if(projects!==undefined&&workspace!==undefined)throw workspaceFailure('invalid_request','Project tools require a server-owned Node workspace');
  if(!Array.isArray(plugins)||plugins.length>WORKSPACE_LIMITS.plugins)throw workspaceFailure('invalid_request','Invalid configured plugins');
  let storageOptions;
  if (jobStorage !== undefined) {
    if (!ownsPluginHost || workspace !== undefined || !jobs || typeof root !== 'string' || !path.isAbsolute(root)) throw workspaceFailure('invalid_request','Storage requires a server-owned Node workspace and job host');
    storageObject(jobStorage,['store'],['redact','artifacts']);
    const stat = await fs.lstat(root,{bigint:true});
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw workspaceFailure('unsafe_path','Storage workspace must be a real directory');
    const canonical = await fs.realpath(root), current = await fs.lstat(canonical,{bigint:true});
    if (!sameIdentity(stat,current)) throw workspaceFailure('conflict','Workspace identity changed');
    storageOptions={...jobStorage,workspaceIdentity:nodeWorkspaceIdentity(canonical,current),pluginArtifacts:Object.fromEntries(plugins.map(item=>[item.plugin?.manifest?.id,item.artifactSha256]))};
  }
  if(!Number.isInteger(port)||port<0||port>65535||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>WORKSPACE_LIMITS.maxTimeoutMs)throw workspaceFailure('invalid_request','Invalid workspace server configuration');
  if(!Array.isArray(allowedOrigins)||allowedOrigins.length>16)throw workspaceFailure('invalid_request','Invalid allowed origins');
  const origins=new Set(allowedOrigins.map(origin=>{let url;try{url=new URL(origin);}catch{throw workspaceFailure('invalid_request','Invalid allowed origin');}if(url.origin!==origin||!['https:','http:'].includes(url.protocol)||url.username||url.password)throw workspaceFailure('invalid_request','Invalid allowed origin');return origin;}));
  if(!notice||typeof notice.text!=='string'||!notice.text||Buffer.byteLength(notice.text)>65536)throw workspaceFailure('invalid_request','An operator notice is required');
  const noticePayload=Object.freeze({id:requireText(notice.id),version:requireText(notice.version,64),sha256:sha256(Buffer.from(notice.text)),text:notice.text});
  if(notice.sha256!==undefined&&notice.sha256!==noticePayload.sha256)throw workspaceFailure('invalid_request','Operator notice digest mismatch');
  workspace??=await createNodeWorkspace({root,writable,manage,binaryArtifacts});
  const generation=randomUUID(),scope=Object.freeze({projectId:workspaceId,sessionId:generation});
  let projectTransport;
  try{projectTransport=await createWorkspaceProjectTransport(workspace,projects,scope);pluginHost??=createPluginHost({hostId:'workspace-host',scope,grants,workspace,backends,jobs,binaryArtifacts,jobStorage:storageOptions});}
  catch(failure){await projectTransport?.close();workspace.dispose?.();throw safeOperationFailure(failure);}
  const pins=new Map();
  try{
    for(const item of plugins){const hash=requireSha256(item.artifactSha256);if(!item.plugin?.manifest?.id||pins.has(item.plugin.manifest.id))throw workspaceFailure('invalid_request','Duplicate or invalid configured plugin');if(item.licenseText!==undefined&&(typeof item.licenseText!=='string'||Buffer.byteLength(item.licenseText)>65536))throw workspaceFailure('invalid_request','Invalid plugin license text');await pluginHost.activate(item.plugin);pins.set(item.plugin.manifest.id,{artifactSha256:hash,...(item.licenseText===undefined?{}:{licenseText:item.licenseText})});}
  }catch(failure){await projectTransport.close();pluginHost.dispose();workspace.dispose?.();throw safeOperationFailure(failure);}
  const metadata=()=>{
    const commands=pluginHost.listCommands();
    return pluginHost.listPlugins().map(manifest=>({manifest,...pins.get(manifest.id),commands:commands.filter(command=>command.pluginId===manifest.id)}));
  };
  const description=()=>parseWorkspaceHello({hostId:'workspace-host',hostVersion:SDK_VERSION,protocolVersion:1,workspace:{id:workspaceId,name,generation},capabilities:{read:true,write:workspace.capabilities?.write===true,manage:workspace.capabilities?.manage===true,commands:pins.size>0},plugins:metadata(),notice:noticePayload});
  let originalDescription;
  try{originalDescription=description();}catch(failure){await projectTransport.close();pluginHost.dispose();workspace.dispose?.();throw safeOperationFailure(failure);}
  const originalMetadata=JSON.stringify({plugins:originalDescription.plugins,capabilities:originalDescription.capabilities});
  const checkedDescription=()=>{const current=description();if(JSON.stringify({plugins:current.plugins,capabilities:current.capabilities})!==originalMetadata)throw workspaceFailure('generation_mismatch','Workspace configuration changed; restart the host');return current;};
  const uploadGrants=new Set(grants);let uploadTransport;
  try{uploadTransport=await createWorkspaceUploadTransport(workspace,uploads,scope,spec=>{
    const current=checkedDescription(),plugin=current.plugins.find(item=>item.manifest.id===spec.pluginId);
    if(!plugin||plugin.artifactSha256!==spec.artifactSha256)throw workspaceFailure('plugin_mismatch','Upload plugin artifact changed');
    if(!current.capabilities.write||!uploadGrants.has('workspace.write')||!plugin.manifest.permissions.includes('workspace.write'))throw workspaceFailure('permission_denied','Current workspace.write grant is required');return true;
  });}catch(failure){await projectTransport.close();pluginHost.dispose();workspace.dispose?.();throw safeOperationFailure(failure);}
  const pending=new Map();let closed=false,receiving=0;
  const expectedToken=Buffer.from(sha256(Buffer.from(token)));
  const authenticated=req=>{const authorization=req.headers.authorization;if(typeof authorization!=='string'||!authorization.startsWith('Bearer ')||authorization.length>520)return false;const actual=Buffer.from(sha256(Buffer.from(authorization.slice(7))));return timingSafeEqual(actual,expectedToken);};
  const reply=(res,requestId,ok,result)=>{
    if(res.destroyed||res.writableEnded)return;
    let value={version:1,requestId,ok,...(ok?{result}:{error:{code:result.code,message:result.message}})},body;
    try{body=JSON.stringify(copyWorkspaceJson(value,{maxBytes:WORKSPACE_LIMITS.wireBytes,maxDepth:24,maxNodes:40000}));}catch{body=JSON.stringify({version:1,requestId,ok:false,error:{code:'budget_exceeded',message:'Workspace response limit exceeded'}});}
    res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);
  };
  async function dispatch(request,signal) {
    const p=request.params;
    if(request.method.startsWith('projects.')){checkedDescription();return projectTransport.dispatch(request.method,p,signal);}
    if(request.method.startsWith('uploads.')){checkedDescription();return uploadTransport.dispatch(request.method,p,signal);}
    if(request.method.startsWith('jobs.')&&request.method!=='jobs.capabilities'&&(!jobs||!ownsPluginHost))throw workspaceFailure('unsupported','Enable jobs on the server-owned plugin host');
    if(request.method.startsWith('history.')&&request.method!=='history.capabilities'&&(!jobs||!ownsPluginHost||!storageOptions))throw workspaceFailure('unsupported','Enable storage on the server-owned job host');
    if(request.method.startsWith('snapshots.')&&request.method!=='snapshots.capabilities'&&(!jobs||!ownsPluginHost||!storageOptions?.artifacts))throw workspaceFailure('unsupported','Enable artifact storage on the server-owned job host');
    if(request.method.startsWith('artifacts.')&&request.method!=='artifacts.capabilities'&&(!jobs||!binaryArtifacts||!ownsPluginHost))throw workspaceFailure('unsupported','Enable binary artifacts on the server-owned job host');
    switch(request.method){
      case 'hello':return checkedDescription();
      case 'fs.list':return{entries:await workspace.listFiles(p.path,{signal})};
      case 'fs.read':return workspace.readFile(p.path,{signal});
      case 'fs.capabilities':checkedDescription();return{protocolVersion:1,revision:true,conditionalRead:true};
      case 'fs.revision':case 'fs.readIfChanged':{
        // One guarded read supplies both the digest and any returned content.
        const file=parseWorkspaceMethodResult('fs.read',await workspace.readFile(p.path,{signal}));
        const metadata={path:file.path,revision:file.revision};
        if(request.method==='fs.revision')return metadata;
        return file.revision===p.knownRevision?{...metadata,notModified:true}:{...file,notModified:false};
      }
      case 'fs.write':if(workspace.capabilities?.write!==true)throw workspaceFailure('permission_denied','Workspace is read-only');return workspace.writeFile(p.path,p.content,{expectedRevision:p.expectedRevision,signal});
      case 'fs.mkdir':if(!workspace.capabilities?.manage||!workspace.mkdir)throw workspaceFailure('permission_denied','Workspace management is disabled');return workspace.mkdir(p.path,{signal});
      case 'fs.rename':if(!workspace.capabilities?.manage||!workspace.rename)throw workspaceFailure('permission_denied','Workspace management is disabled');return workspace.rename(p.path,p.newPath,{expectedRevision:p.expectedRevision,signal});
      case 'fs.remove':if(!workspace.capabilities?.manage||!workspace.remove)throw workspaceFailure('permission_denied','Workspace management is disabled');return workspace.remove(p.path,{expectedRevision:p.expectedRevision,signal});
      case 'plugins.list':return{plugins:checkedDescription().plugins};
      case 'commands.run':checkedDescription();if(pins.get(p.pluginId)?.artifactSha256!==p.artifactSha256)throw workspaceFailure('plugin_mismatch','Plugin artifact identity changed');return pluginHost.executeCommand(p.pluginId,p.commandId,p.input,{signal,timeoutMs});
      case 'jobs.capabilities':checkedDescription();return ownsPluginHost?pluginHost.jobCapabilities():{protocolVersion:1,enabled:false,limits:JOB_LIMITS};
      case 'history.capabilities':checkedDescription();return ownsPluginHost?pluginHost.jobStorageCapabilities():{protocolVersion:1,enabled:false,identity:null,limits:JOB_STORE_LIMITS};
      case 'snapshots.capabilities':checkedDescription();return ownsPluginHost?pluginHost.artifactStorageCapabilities():{protocolVersion:1,enabled:false,identity:null,limits:ARTIFACT_STORE_LIMITS};
      case 'snapshots.list':case 'snapshots.get':{
        checkedDescription();if(pins.get(p.pluginId)?.artifactSha256!==p.artifactSha256)throw workspaceFailure('plugin_mismatch','Plugin artifact identity changed');
        if(request.method==='snapshots.list')return pluginHost.listStoredJobArtifacts(p.pluginId,p.jobId);
        return pluginHost.getStoredJobArtifact(p.pluginId,p.jobId,p.artifactId,{signal,timeoutMs});
      }
      case 'snapshots.read':{
        checkedDescription();const s=p.reference.snapshot;
        if(p.reference.scope.projectId!==workspaceId||p.reference.scope.sessionId!==generation)throw workspaceFailure('generation_mismatch','Stored artifact belongs to another generation');
        if(pins.get(s.pluginId)?.artifactSha256!==s.pluginArtifactSha256)throw workspaceFailure('plugin_mismatch','Plugin artifact identity changed');
        return pluginHost.readStoredJobArtifactChunk(p.reference,p.offset,p.length,{signal,timeoutMs});
      }
      case 'history.list':case 'history.recover':case 'history.retry':{
        checkedDescription();if(pins.get(p.pluginId)?.artifactSha256!==p.artifactSha256)throw workspaceFailure('plugin_mismatch','Plugin artifact identity changed');
        if(request.method==='history.list')return pluginHost.listJobHistory(p.pluginId,p.query);
        if(request.method==='history.recover')return pluginHost.recoverJob(p.pluginId,p.jobId);
        return pluginHost.retryCommandJob(p.pluginId,p.previousJobId,p.input,{jobId:p.jobId,...(p.timeoutMs===undefined?{}:{timeoutMs:p.timeoutMs})});
      }
      case 'jobs.start':checkedDescription();if(pins.get(p.pluginId)?.artifactSha256!==p.artifactSha256)throw workspaceFailure('plugin_mismatch','Plugin artifact identity changed');if(!pluginHost.startCommandJob)throw workspaceFailure('unsupported','Jobs are unavailable');return pluginHost.startCommandJob(p.pluginId,p.commandId,p.input,{jobId:p.jobId,...(p.timeoutMs===undefined?{}:{timeoutMs:p.timeoutMs})});
      case 'jobs.get':checkedDescription();if(!pluginHost.getJob)throw workspaceFailure('unsupported','Jobs are unavailable');return pluginHost.getJob(p.jobId);
      case 'jobs.events':checkedDescription();if(!pluginHost.getJobEvents)throw workspaceFailure('unsupported','Jobs are unavailable');return pluginHost.getJobEvents(p.jobId,p.after);
      case 'jobs.cancel':checkedDescription();if(!pluginHost.cancelJob)throw workspaceFailure('unsupported','Jobs are unavailable');return pluginHost.cancelJob(p.jobId);
      case 'jobs.artifact':checkedDescription();if(!pluginHost.readJobArtifact)throw workspaceFailure('unsupported','Jobs are unavailable');return pluginHost.readJobArtifact(p.jobId,p.artifactId,{signal});
      case 'artifacts.capabilities':checkedDescription();return ownsPluginHost?pluginHost.binaryArtifactCapabilities():{protocolVersion:1,enabled:false,limits:BINARY_ARTIFACT_LIMITS};
      case 'artifacts.list':checkedDescription();return pluginHost.listJobBinaryArtifacts(p.jobId);
      case 'artifacts.read':checkedDescription();return pluginHost.readJobBinaryArtifactChunk(p.jobId,p.artifactId,p.revision,p.offset,p.length,{signal,timeoutMs});
      case 'request.cancel':{const target=pending.get(p.requestId);if(target)target.abort(workspaceFailure('cancelled','Workspace request cancelled'));return{cancelled:!!target};}
    }
  }
  const server=createServer(async(req,res)=>{
    // Check the raw count too: runtimes that truncate parsed headers must not
    // silently discard security-relevant headers such as Origin.
    if(req.rawHeaders.length>64){res.writeHead(431,{'connection':'close','cache-control':'no-store'});res.end();return;}
    const origin=req.headers.origin;
    if(origin!==undefined&&(typeof origin!=='string'||origin==='null'||!origins.has(origin))){res.writeHead(403,{'content-type':'application/json'});res.end('{"error":"origin denied"}');return;}
    if(origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');}
    if(req.url!==WORKSPACE_PATH){res.writeHead(404);res.end();return;}
    if(req.method==='OPTIONS'){if(!origin){res.writeHead(403);res.end();return;}res.writeHead(204,{'access-control-allow-methods':'POST','access-control-allow-headers':'authorization,content-type','access-control-max-age':'300'});res.end();return;}
    if(req.method!=='POST'||!authenticated(req)){res.writeHead(401,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"authentication required"}');return;}
    if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'){res.writeHead(415);res.end();return;}
    if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'){res.writeHead(415);res.end();return;}
    const declared=req.headers['content-length'];if(declared&&(!/^\d+$/.test(declared)||Number(declared)>WORKSPACE_LIMITS.wireBytes)){res.writeHead(413);res.end();return;}
    // The execution queue is checked after JSON parsing. Bound uploads before
    // buffering them as well, then release this slot before dispatch/cancel.
    if(receiving>=WORKSPACE_LIMITS.receiving){res.writeHead(429,{'content-type':'application/json','cache-control':'no-store','connection':'close'});res.end('{"error":"request body capacity exceeded"}');return;}
    receiving++;let receivingBody=true;
    const releaseBody=()=>{if(receivingBody){receivingBody=false;receiving--;}};
    const controller=new AbortController();let requestId='invalid-request',registered=false,timer,bodyTimer;
    const onDisconnect=()=>{if(!res.writableEnded)controller.abort(workspaceFailure('cancelled','Workspace client disconnected'));};
    req.on('aborted',onDisconnect);res.on('close',onDisconnect);
    try{
      bodyTimer=setTimeout(()=>{controller.abort(workspaceFailure('budget_exceeded','Workspace request body timed out'));req.destroy();},timeoutMs);
      let bytes=0;const chunks=[];
      for await(const chunk of req){bytes+=chunk.length;if(bytes>WORKSPACE_LIMITS.wireBytes)throw workspaceFailure('budget_exceeded','Workspace request limit exceeded');chunks.push(chunk);}
      clearTimeout(bodyTimer);releaseBody();
      let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw workspaceFailure('invalid_request','Request body must be UTF-8 JSON');}
      const request=parseWorkspaceRequest(text);requestId=request.requestId;
      if(closed)throw workspaceFailure('disposed','Workspace server is disposed');
      if(request.method!=='hello'){if(request.workspaceId!==workspaceId)throw workspaceFailure('workspace_mismatch','Workspace identity changed');if(request.generation!==generation)throw workspaceFailure('generation_mismatch','Workspace generation changed');}
      if(pending.has(requestId))throw workspaceFailure('conflict','Request ID is already pending');
      if(request.method!=='request.cancel'&&pending.size>=WORKSPACE_LIMITS.pending)throw workspaceFailure('budget_exceeded','Pending request limit exceeded');
      if(request.method!=='request.cancel'){pending.set(requestId,controller);registered=true;}
      let rejectAbort;const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',rejectAbort,{once:true});});
      timer=setTimeout(()=>controller.abort(workspaceFailure('budget_exceeded','Workspace request timed out')),timeoutMs);
      try{
        aborted(controller.signal);const result=await Promise.race([Promise.resolve().then(()=>dispatch(request,controller.signal)),cancelled]);aborted(controller.signal);
        reply(res,requestId,true,parseWorkspaceMethodResult(request.method,result));
      }finally{controller.signal.removeEventListener('abort',rejectAbort);}
    }catch(failure){reply(res,requestId,false,safeOperationFailure(failure));}
    finally{releaseBody();clearTimeout(bodyTimer);clearTimeout(timer);if(registered)pending.delete(requestId);req.off('aborted',onDisconnect);res.off('close',onDisconnect);}
  });
  server.headersTimeout=10_000;server.requestTimeout=10_000;server.maxHeadersCount=32;
  server.maxConnections=WORKSPACE_LIMITS.connections;server.dropMaxConnection=true;server.maxRequestsPerSocket=128;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve();});});}catch(failure){await uploadTransport.close();await projectTransport.close();pluginHost.dispose();workspace.dispose?.();throw safeOperationFailure(failure);}
  const address=server.address();
  return Object.freeze({url:`http://${host.includes(':')?`[${host}]`:host}:${address.port}${WORKSPACE_PATH}`,workspaceId,generation,hello:checkedDescription,
    revokeProjects(){projectTransport.revoke();},
    revokeUploads(){uploadTransport.revoke();},
    async close(){if(closed)return;closed=true;for(const controller of pending.values())controller.abort(workspaceFailure('disposed','Workspace server is disposed'));await uploadTransport.close();await projectTransport.close();pluginHost.dispose();workspace.dispose?.();await new Promise(resolve=>{server.close(()=>resolve());server.closeAllConnections();});if(storageOptions)await pluginHost.flushJobStore();},
  });
}
