import {WORKSPACE_LIMITS,WORKSPACE_ERROR_CODES,WorkspaceError,workspaceFailure,requireText,requireUuid,requireSha256,requireToken,isProtectedWorkspaceComponent,requireWorkspacePath,requireFileContent,exactObject,copyWorkspaceJson} from './workspace-values.mjs';
export {WORKSPACE_LIMITS,WORKSPACE_ERROR_CODES,WorkspaceError,workspaceFailure,requireText,requireUuid,requireSha256,requireToken,isProtectedWorkspaceComponent,requireWorkspacePath,requireFileContent,exactObject,copyWorkspaceJson} from './workspace-values.mjs';
import {parseManifest, parseCommandDefinition} from './contracts.mjs';
import {parseJobId, parseJobOptions, parseJobSnapshot, parseJobEvents, parseJobCapabilities, parseJobArtifactContent} from './jobs.mjs';
import {parseBinaryArtifactRange, parseBinaryArtifactList, parseBinaryArtifactCapabilities, parseBinaryArtifactChunk} from './artifacts.mjs';
import {parseJobStorageCapabilities, parseJobRecovery} from './job-storage.mjs';
import {parseJobHistoryQuery, parseJobHistoryPage} from './job-history.mjs';
import {parseStoredArtifactReference,parseStoredArtifactChunk,parseStoredArtifactList,parseArtifactStorageCapabilities} from './artifact-storage.mjs';
import {parseProjectWatchOptions} from './project-watch.mjs';
import {parseProjectQueryOptions,parseProjectQueryCursor} from './project-query.mjs';
import {WORKSPACE_PROJECT_LIMITS,parseWorkspaceProjectResult} from './workspace-project-contracts.mjs';
export const WORKSPACE_PROTOCOL_VERSION = 1;
export const WORKSPACE_PATH = '/dds/workspace/v1';
export const WORKSPACE_METHODS = Object.freeze(['hello', 'fs.list', 'fs.read', 'fs.capabilities', 'fs.revision', 'fs.readIfChanged', 'fs.write', 'fs.mkdir', 'fs.rename', 'fs.remove', 'plugins.list', 'commands.run', 'request.cancel', 'jobs.capabilities', 'jobs.start', 'jobs.get', 'jobs.events', 'jobs.cancel', 'jobs.artifact', 'artifacts.capabilities', 'artifacts.list', 'artifacts.read', 'history.capabilities', 'history.list', 'history.recover', 'history.retry', 'snapshots.capabilities', 'snapshots.list', 'snapshots.get', 'snapshots.read', 'projects.capabilities', 'projects.snapshot', 'projects.query', 'projects.query.release', 'projects.watch.start', 'projects.watch.next', 'projects.watch.stop']);
const encoder=new TextEncoder();
const invalid=()=>{throw workspaceFailure('invalid_request','Invalid workspace contract');};

function wireInput(value) {
  if (typeof value === 'string') {
    if (value.length > WORKSPACE_LIMITS.wireBytes || encoder.encode(value).byteLength > WORKSPACE_LIMITS.wireBytes) throw workspaceFailure('budget_exceeded', 'Workspace message limit exceeded');
    try { value = JSON.parse(value); } catch { invalid(); }
  }
  return copyWorkspaceJson(value, {maxBytes: WORKSPACE_LIMITS.wireBytes, maxDepth: 24, maxNodes: 40_000});
}
export function parseWorkspaceRequest(value) {
  value = wireInput(value);
  exactObject(value, ['version', 'requestId', 'method', 'params'], ['workspaceId', 'generation']);
  if (value.version !== 1 || !WORKSPACE_METHODS.includes(value.method)) invalid();
  requireText(value.requestId);
  if (value.method !== 'hello') { requireUuid(value.workspaceId); requireUuid(value.generation); }
  else { if (value.workspaceId !== undefined) requireUuid(value.workspaceId); if (value.generation !== undefined) requireUuid(value.generation); }
  const p = value.params;
  switch (value.method) {
    case 'hello': case 'plugins.list': case 'jobs.capabilities': case 'fs.capabilities': case 'artifacts.capabilities': case 'history.capabilities': case 'snapshots.capabilities': case 'projects.capabilities': exactObject(p, []); break;
    case 'projects.snapshot':exactObject(p,['options']);parseProjectWatchOptions(p.options);break;
    case 'projects.query':exactObject(p,['query']);parseProjectQueryOptions(p.query);break;
    case 'projects.query.release':exactObject(p,['cursor']);parseProjectQueryCursor(p.cursor);break;
    case 'projects.watch.start':exactObject(p,['subscriptionId','options']);requireUuid(p.subscriptionId);parseProjectWatchOptions(p.options);break;
    case 'projects.watch.next':exactObject(p,['subscriptionId','after','waitMs']);requireUuid(p.subscriptionId);if(!Number.isSafeInteger(p.after)||p.after<1||!Number.isSafeInteger(p.waitMs)||p.waitMs<1||p.waitMs>WORKSPACE_PROJECT_LIMITS.maxPollMs)invalid();break;
    case 'projects.watch.stop':exactObject(p,['subscriptionId']);requireUuid(p.subscriptionId);break;
    case 'snapshots.list':case 'snapshots.get':
      exactObject(p,['pluginId','artifactSha256','jobId',...(value.method==='snapshots.get'?['artifactId']:[])]);requireText(p.pluginId);requireSha256(p.artifactSha256);
      if(value.method==='snapshots.get')requireText(p.artifactId);try{parseJobId(p.jobId);}catch{invalid();}break;
    case 'snapshots.read':
      exactObject(p,['reference','offset','length']);try{const r=parseStoredArtifactReference(p.reference);parseBinaryArtifactRange(p.offset,p.length,r.snapshot.artifact.byteLength);}catch{invalid();}break;
    case 'history.list':
      exactObject(p,['pluginId','artifactSha256','query']);requireText(p.pluginId);requireSha256(p.artifactSha256);
      try {parseJobHistoryQuery(p.query);} catch {invalid();} break;
    case 'history.recover':
      exactObject(p,['pluginId','artifactSha256','jobId']);requireText(p.pluginId);requireSha256(p.artifactSha256);
      try {parseJobId(p.jobId);} catch {invalid();} break;
    case 'history.retry':
      exactObject(p,['pluginId','artifactSha256','previousJobId','input','jobId'],['timeoutMs']);requireText(p.pluginId);requireSha256(p.artifactSha256);copyWorkspaceJson(p.input);
      try {parseJobId(p.previousJobId);parseJobOptions({jobId:p.jobId,...(p.timeoutMs===undefined?{}:{timeoutMs:p.timeoutMs})});} catch {invalid();} break;
    case 'fs.list': exactObject(p, ['path']); requireWorkspacePath(p.path, true); break;
    case 'fs.read': case 'fs.revision': case 'fs.mkdir': exactObject(p, ['path']); requireWorkspacePath(p.path); break;
    case 'fs.readIfChanged': exactObject(p, ['path', 'knownRevision']); requireWorkspacePath(p.path); if (p.knownRevision !== null) requireSha256(p.knownRevision); break;
    case 'fs.write': exactObject(p, ['path', 'content', 'expectedRevision']); requireWorkspacePath(p.path); requireFileContent(p.content); if (p.expectedRevision !== null) requireSha256(p.expectedRevision); break;
    case 'fs.rename': exactObject(p, ['path', 'newPath'], ['expectedRevision']); requireWorkspacePath(p.path); requireWorkspacePath(p.newPath); if (p.expectedRevision !== undefined) requireSha256(p.expectedRevision); break;
    case 'fs.remove': exactObject(p, ['path'], ['expectedRevision']); requireWorkspacePath(p.path); if (p.expectedRevision !== undefined) requireSha256(p.expectedRevision); break;
    case 'commands.run': exactObject(p, ['pluginId', 'commandId', 'input', 'artifactSha256']); requireText(p.pluginId); requireText(p.commandId); requireSha256(p.artifactSha256); copyWorkspaceJson(p.input); break;
    case 'request.cancel': exactObject(p, ['requestId']); requireText(p.requestId); break;
    case 'jobs.start':
      exactObject(p, ['pluginId', 'commandId', 'input', 'artifactSha256', 'jobId'], ['timeoutMs']);
      requireText(p.pluginId); requireText(p.commandId); requireSha256(p.artifactSha256); copyWorkspaceJson(p.input);
      try {parseJobOptions({jobId: p.jobId, ...(p.timeoutMs === undefined ? {} : {timeoutMs: p.timeoutMs})});} catch {invalid();} break;
    case 'jobs.get': case 'jobs.cancel': case 'artifacts.list': exactObject(p, ['jobId']); try {parseJobId(p.jobId);} catch {invalid();} break;
    case 'jobs.events': exactObject(p, ['jobId', 'after']); try {parseJobId(p.jobId);} catch {invalid();} if (!Number.isSafeInteger(p.after) || p.after < 0) invalid(); break;
    case 'jobs.artifact': exactObject(p, ['jobId', 'artifactId']); try {parseJobId(p.jobId);} catch {invalid();} requireText(p.artifactId); break;
    case 'artifacts.read':
      exactObject(p, ['jobId', 'artifactId', 'revision', 'offset', 'length']); requireText(p.artifactId); requireSha256(p.revision);
      try {parseJobId(p.jobId); parseBinaryArtifactRange(p.offset, p.length);} catch {invalid();} break;
  }
  return value;
}
export function parseWorkspaceReply(value, expectedRequestId) {
  value = wireInput(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  if (value.ok === true) exactObject(value, ['version', 'requestId', 'ok', 'result']);
  else if (value.ok === false) {
    exactObject(value, ['version', 'requestId', 'ok', 'error']);
    exactObject(value.error, ['code', 'message']);
    if (!WORKSPACE_ERROR_CODES.includes(value.error.code)) invalid();
    requireText(value.error.message, 2_048);
  } else invalid();
  if (value.version !== 1 || value.requestId !== expectedRequestId) invalid();
  return value;
}
function validatePlugins(plugins) {
  if (!Array.isArray(plugins) || plugins.length > WORKSPACE_LIMITS.plugins) invalid();
  const ids = new Set();
  for (const plugin of plugins) {
    exactObject(plugin, ['manifest', 'artifactSha256', 'commands'], ['licenseText']); requireSha256(plugin.artifactSha256);
    let manifest;
    try { manifest = parseManifest(plugin.manifest); } catch { invalid(); }
    if (manifest.protocolVersion !== 1 || !manifest.supportedHosts.includes('workspace-host') || manifest.manifestVersion !== 2 || manifest.runtime !== 'workspace') invalid();
    const id = manifest.id; if (ids.has(id)) invalid(); ids.add(id);
    if (!Array.isArray(plugin.commands) || plugin.commands.length > 64) invalid();
    const commandIds = new Set();
    for (const command of plugin.commands) {
      exactObject(command, ['pluginId', 'id', 'title'], ['description', 'parameters']);
      if (command.pluginId !== id || commandIds.has(command.id)) invalid();
      const {pluginId: _, ...definition} = command;
      try { parseCommandDefinition(definition); } catch { invalid(); }
      commandIds.add(command.id);
    }
    if (plugin.licenseText !== undefined && (typeof plugin.licenseText !== 'string' || encoder.encode(plugin.licenseText).length > 65_536)) invalid();
  }
}
export function parseWorkspaceHello(value) {
  value = wireInput(value);
  exactObject(value, ['hostId', 'hostVersion', 'protocolVersion', 'workspace', 'capabilities', 'plugins', 'notice']);
  requireText(value.hostId); requireText(value.hostVersion, 64); if (value.protocolVersion !== 1) invalid();
  exactObject(value.workspace, ['id', 'name', 'generation']); requireUuid(value.workspace.id); requireUuid(value.workspace.generation); requireText(value.workspace.name, 128);
  exactObject(value.capabilities, ['read', 'write', 'commands', 'manage']);
  if (value.capabilities.read !== true || Object.values(value.capabilities).some(v => typeof v !== 'boolean')) invalid();
  validatePlugins(value.plugins);
  exactObject(value.notice, ['id', 'version', 'sha256', 'text']); requireText(value.notice.id); requireText(value.notice.version, 64); requireSha256(value.notice.sha256);
  if (typeof value.notice.text !== 'string' || !value.notice.text || encoder.encode(value.notice.text).length > 65_536) invalid();
  return value;
}
export function parseWorkspaceMethodResult(method, value) {
  value = wireInput(value);
  if (method === 'hello') return parseWorkspaceHello(value);
  if(method.startsWith('projects.'))return parseWorkspaceProjectResult(method,value);
  if(method.startsWith('snapshots.')){
    try{
      if(method==='snapshots.capabilities')return parseArtifactStorageCapabilities(value);
      if(method==='snapshots.list')return parseStoredArtifactList(value);
      if(method==='snapshots.get')return parseStoredArtifactReference(value);
      if(method==='snapshots.read')return parseStoredArtifactChunk(value);
    }catch{invalid();}invalid();
  }
  if (method.startsWith('history.')) {
    try {
      if (method === 'history.capabilities') return parseJobStorageCapabilities(value);
      if (method === 'history.list') return parseJobHistoryPage(value);
      if (method === 'history.recover' || method === 'history.retry') return parseJobRecovery(value);
    } catch {invalid();}
    invalid();
  }
  if (method.startsWith('artifacts.')) {
    try {
      if (method === 'artifacts.capabilities') return parseBinaryArtifactCapabilities(value);
      if (method === 'artifacts.list') return parseBinaryArtifactList(value);
      if (method === 'artifacts.read') return parseBinaryArtifactChunk(value);
    } catch {invalid();}
    invalid();
  }
  if (method.startsWith('jobs.')) {
    try {
      if (method === 'jobs.capabilities') return parseJobCapabilities(value);
      if (method === 'jobs.events') return parseJobEvents(value);
      if (method === 'jobs.artifact') return parseJobArtifactContent(value);
      if (['jobs.start', 'jobs.get', 'jobs.cancel'].includes(method)) return parseJobSnapshot(value);
    } catch {invalid();}
    invalid();
  }
  if (method === 'fs.list') {
    exactObject(value, ['entries']);
    if (!Array.isArray(value.entries) || value.entries.length > WORKSPACE_LIMITS.entries) invalid();
    const paths = new Set();
    for (const entry of value.entries) {
      exactObject(entry, ['path', 'name', 'kind'], ['size', 'revision']); requireWorkspacePath(entry.path); requireText(entry.name, 255);
      if (entry.path.split('/').at(-1) !== entry.name || paths.has(entry.path) || !['file', 'directory'].includes(entry.kind)) invalid(); paths.add(entry.path);
      if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0)) invalid();
      if (entry.revision !== undefined) requireSha256(entry.revision);
    }
  } else if (method === 'fs.read') { exactObject(value, ['path', 'content', 'revision']); requireWorkspacePath(value.path); requireFileContent(value.content); requireSha256(value.revision); }
  else if (method === 'fs.capabilities') {
    exactObject(value, ['protocolVersion', 'revision', 'conditionalRead']);
    if (value.protocolVersion !== 1 || typeof value.revision !== 'boolean' || typeof value.conditionalRead !== 'boolean') invalid();
  }
  else if (method === 'fs.readIfChanged') {
    if (value?.notModified === true) exactObject(value, ['path', 'revision', 'notModified']);
    else if (value?.notModified === false) {exactObject(value, ['path', 'revision', 'notModified', 'content']); requireFileContent(value.content);}
    else invalid();
    requireWorkspacePath(value.path); requireSha256(value.revision);
  }
  else if (method === 'fs.write' || method === 'fs.revision') { exactObject(value, ['path', 'revision']); requireWorkspacePath(value.path); requireSha256(value.revision); }
  else if (method === 'fs.rename') { exactObject(value, ['path', 'newPath']); requireWorkspacePath(value.path); requireWorkspacePath(value.newPath); }
  else if (method === 'fs.mkdir' || method === 'fs.remove') { exactObject(value, ['path']); requireWorkspacePath(value.path); }
  else if (method === 'request.cancel') { exactObject(value, ['cancelled']); if (typeof value.cancelled !== 'boolean') invalid(); }
  else if (method === 'plugins.list') { exactObject(value, ['plugins']); validatePlugins(value.plugins); }
  else if (method === 'commands.run') return copyWorkspaceJson(value);
  else invalid();
  return value;
}
