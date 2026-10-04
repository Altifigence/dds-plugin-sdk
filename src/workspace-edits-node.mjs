import * as fs from 'node:fs/promises';
import {constants as flags} from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {requireUuid, exactObject} from './workspace-values.mjs';
import {nodeWorkspaceIdentity} from './workspace-identity-node.mjs';
import {WORKSPACE_EDIT_LIMITS, parseWorkspaceEditRecord, canonicalEditJson, editHash, editCopy, editFailure} from './workspace-edit-contracts.mjs';

const maximum = WORKSPACE_EDIT_LIMITS.previewBytes + 131_072;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const contained = (root, target) => {const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);};
const isId = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const mapped = error => {
  if (error?.name === 'WorkspaceError') return error;
  return editFailure(['EEXIST', 'ENOTEMPTY'].includes(error?.code) ? 'conflict' : ['EPERM', 'EACCES'].includes(error?.code) ? 'permission_denied' : ['ENOSPC', 'EDQUOT', 'EFBIG'].includes(error?.code) ? 'budget_exceeded' : error?.code === 'ENOENT' ? 'not_found' : 'provider_failed');
};
async function realDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw editFailure('invalid_request');
  const supplied = await fs.lstat(value, {bigint: true});
  if (!supplied.isDirectory() || supplied.isSymbolicLink()) throw editFailure('unsafe_path');
  const canonical = await fs.realpath(value), stat = await fs.lstat(canonical, {bigint: true});
  if (!stat.isDirectory() || stat.isSymbolicLink() || !same(supplied, stat)) throw editFailure('conflict');
  return {canonical, stat};
}
async function regularBytes(file, limit = maximum) {
  const before = await fs.lstat(file, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(limit)) throw editFailure('unsafe_path');
  const handle = await fs.open(file, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({bigint: true});
    if (!same(opened, before) || !opened.isFile() || opened.nlink !== 1n || opened.size !== before.size) throw editFailure('conflict');
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) {const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw editFailure('conflict'); offset += result.bytesRead;}
    const after = await handle.stat({bigint: true}), current = await fs.lstat(file, {bigint: true});
    if (!same(after, opened) || !same(current, opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || current.isSymbolicLink() || current.nlink !== 1n) throw editFailure('conflict');
    return bytes;
  } finally {await handle.close();}
}
const decode = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
function owner(input) {
  exactObject(input, ['pid', 'host', 'token']); requireUuid(input.token);
  if (!Number.isSafeInteger(input.pid) || input.pid < 1 || typeof input.host !== 'string' || !input.host || input.host.length > 256) throw editFailure('invalid_request');
  return input;
}
function definitelyDead(value) {
  if (value.host !== hostname() || value.pid === process.pid) return false;
  try {process.kill(value.pid, 0); return false;} catch (error) {return error?.code === 'ESRCH';}
}
function unpack(bytes) {
  const envelope = decode(bytes); exactObject(envelope, ['formatVersion', 'sha256', 'record']);
  if (envelope.formatVersion !== 1) throw editFailure('unsupported');
  const record = parseWorkspaceEditRecord(envelope.record);
  if (envelope.sha256 !== editHash(canonicalEditJson(record))) throw editFailure('conflict');
  return record;
}

/** Operator-owned local storage, outside the workspace, with one writer. */
export async function createNodeWorkspaceEditJournal({directory, workspaceRoot, workspaceId, recoverStaleLock = false} = {}) {
  requireUuid(workspaceId);
  if (typeof recoverStaleLock !== 'boolean' || typeof directory !== 'string' || !path.isAbsolute(directory)) throw editFailure('invalid_request');
  let root, initial, workspaceBinding, lockToken, closed = false, closing = false, tail = Promise.resolve(), queued = 0, closePromise;
  const owned = new Map(), sizes = new Map(), directories = new Map(); let totalBytes = 0;
  const currentOwner = {pid: process.pid, host: hostname(), token: randomUUID()};
  async function checkRoot(checkWorkspace = true) {
    const current = await realDirectory(root);
    if (current.canonical !== root || !same(current.stat, initial)) throw editFailure('conflict');
    if (checkWorkspace) {
      const workspace = await realDirectory(workspaceRoot);
      if (nodeWorkspaceIdentity(workspace.canonical, workspace.stat) !== workspaceBinding) throw editFailure('workspace_mismatch');
    }
  }
  async function checkOwned(checkWorkspace = true) {
    if (closed) throw editFailure('disposed');
    await checkRoot(checkWorkspace);
    const writer = owner(decode(await regularBytes(path.join(root, '.writer.lock'), 2048)));
    if (writer.token !== lockToken || writer.pid !== process.pid || writer.host !== hostname()) throw editFailure('conflict');
  }
  async function syncDirectory(target) {
    if (process.platform === 'win32') return;
    const handle = await fs.open(target, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
    try {await handle.sync();} finally {await handle.close();}
  }
  async function exclusive(file, bytes) {
    const handle = await fs.open(file, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | (flags.O_NOFOLLOW ?? 0), 0o600);
    try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  }
  async function acquire() {
    const lock = path.join(root, '.writer.lock'), recovery = path.join(root, '.recovery.lock');
    try {await fs.lstat(recovery); throw editFailure('conflict');} catch (error) {if (error.code !== 'ENOENT') throw error;}
    try {await exclusive(lock, JSON.stringify(currentOwner)); lockToken = currentOwner.token;}
    catch (error) {
      if (error.code !== 'EEXIST' || !recoverStaleLock) throw error;
      const previous = owner(decode(await regularBytes(lock, 2048)));
      if (!definitelyDead(previous)) throw editFailure('conflict');
      await exclusive(recovery, JSON.stringify(currentOwner));
      try {
        await checkRoot(); const confirmed = owner(decode(await regularBytes(lock, 2048)));
        if (confirmed.token !== previous.token || !definitelyDead(confirmed)) throw editFailure('conflict');
        await fs.unlink(lock); await exclusive(lock, JSON.stringify(currentOwner)); lockToken = currentOwner.token;
      } finally {
        const guard = owner(decode(await regularBytes(recovery, 2048)));
        if (guard.token !== currentOwner.token) throw editFailure('conflict');
        await fs.unlink(recovery);
      }
    }
    try {await fs.lstat(recovery); throw editFailure('conflict');} catch (error) {if (error.code !== 'ENOENT') throw error;}
    await syncDirectory(root);
  }
  async function checkPlan(id) {
    requireUuid(id); await checkOwned();
    const target = path.join(root, id), inspected = await realDirectory(target);
    if (inspected.canonical !== target || directories.has(id) && !same(inspected.stat, directories.get(id))) throw editFailure('conflict');
    directories.set(id, inspected.stat); return target;
  }
  async function read(id) {
    const target = await checkPlan(id), bytes = await regularBytes(path.join(target, 'record.json'));
    const record = unpack(bytes);
    if (record.preview.planId !== id || record.preview.workspace.id !== workspaceId) throw editFailure('workspace_mismatch');
    await checkOwned(); return record;
  }
  async function save(record, beginning) {
    await checkOwned(); record = parseWorkspaceEditRecord(record);
    const id = record.preview.planId;
    if (record.preview.workspace.id !== workspaceId) throw editFailure('workspace_mismatch');
    if (beginning && (record.revision !== 1 || record.phase !== 'applying' || record.steps.some(step => step.state !== 'pending'))) throw editFailure('invalid_request');
    if (!beginning) {
      const previous = owned.get(id);
      if (!previous || record.revision !== previous.revision + 1 || record.preview.digest !== previous.digest) throw editFailure('conflict');
      const stored = await read(id);
      if (stored.revision !== previous.revision || editHash(canonicalEditJson(stored)) !== previous.sha256) throw editFailure('conflict');
    }
    const sha256 = editHash(canonicalEditJson(record)), bytes = Buffer.from(JSON.stringify({formatVersion: 1, sha256, record}));
    if (bytes.length > maximum || totalBytes - (sizes.get(id) ?? 0) + bytes.length > WORKSPACE_EDIT_LIMITS.journalBytes || beginning && sizes.size >= WORKSPACE_EDIT_LIMITS.journalRecords) throw editFailure('budget_exceeded');
    let target;
    if (beginning) {
      target = path.join(root, id); await fs.mkdir(target, {mode: 0o700});
      const inspected = await realDirectory(target);
      if (inspected.canonical !== target) throw editFailure('conflict');
      directories.set(id, inspected.stat); sizes.set(id, 0); await syncDirectory(root);
    } else target = await checkPlan(id);
    const temporary = path.join(target, '.checkpoint-' + randomUUID()); let created = false;
    try {
      await exclusive(temporary, bytes); created = true; await checkPlan(id);
      const file = path.join(target, 'record.json');
      if (beginning) {try {await fs.lstat(file); throw editFailure('conflict');} catch (error) {if (error.code !== 'ENOENT') throw error;}}
      else await regularBytes(file);
      await fs.rename(temporary, file); created = false; await syncDirectory(target); await checkOwned();
      const stored = await read(id);
      if (editHash(canonicalEditJson(stored)) !== sha256) throw editFailure('conflict');
      totalBytes += bytes.length - (sizes.get(id) ?? 0); sizes.set(id, bytes.length);
      owned.set(id, {revision: record.revision, digest: record.preview.digest, sha256});
    } finally {
      if (created) {await checkPlan(id); await regularBytes(temporary); await fs.unlink(temporary);}
    }
  }
  function schedule(operation) {
    if (closed || closing) return Promise.reject(editFailure('disposed'));
    if (queued >= 64) return Promise.reject(editFailure('budget_exceeded'));
    queued++;
    const result = tail.then(operation).catch(error => {throw mapped(error);}).finally(() => {queued--;});
    tail = result.catch(() => {}); return result;
  }
  async function release() {
    if (!lockToken) return;
    await checkOwned(false); await fs.unlink(path.join(root, '.writer.lock')); lockToken = undefined; await syncDirectory(root);
  }
  try {
    const workspace = await realDirectory(workspaceRoot); workspaceBinding = nodeWorkspaceIdentity(workspace.canonical, workspace.stat);
    const parent = await realDirectory(path.dirname(directory)), requested = path.join(parent.canonical, path.basename(directory));
    if (contained(workspace.canonical, requested) || contained(requested, workspace.canonical)) throw editFailure('unsafe_path');
    try {await fs.mkdir(requested, {mode: 0o700});} catch (error) {if (error.code !== 'EEXIST') throw error;}
    const created = await realDirectory(requested); root = created.canonical; initial = created.stat;
    if (root !== requested) throw editFailure('unsafe_path');
    await acquire();
    const identityPath = path.join(root, 'identity.json'), identity = {formatVersion: 1, workspaceId, workspaceIdentity: workspaceBinding};
    try {
      const stored = decode(await regularBytes(identityPath, 2048));
      if (canonicalEditJson(editCopy(stored, 2048)) !== canonicalEditJson(identity)) throw editFailure('workspace_mismatch');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await fs.readdir(root)).some(name => name !== '.writer.lock')) throw editFailure('conflict');
      await exclusive(identityPath, JSON.stringify(identity)); await syncDirectory(root);
    }
    const entries = await fs.readdir(root, {withFileTypes: true});
    if (entries.length > WORKSPACE_EDIT_LIMITS.journalRecords + 2) throw editFailure('budget_exceeded');
    for (const entry of entries) {
      if (['identity.json', '.writer.lock'].includes(entry.name)) continue;
      if (!isId(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw editFailure('unsafe_path');
      const target = await checkPlan(entry.name); let size = 0;
      for (const file of await fs.readdir(target, {withFileTypes: true})) {
        if (file.name !== 'record.json' && !/^\.checkpoint-[a-f0-9-]{36}$/.test(file.name)) throw editFailure('unsafe_path');
        size += (await regularBytes(path.join(target, file.name))).length;
      }
      totalBytes += size; sizes.set(entry.name, size);
    }
    if (totalBytes > WORKSPACE_EDIT_LIMITS.journalBytes) throw editFailure('budget_exceeded');
  } catch (error) {try {await release();} catch {} closed = true; throw mapped(error);}
  return Object.freeze({
    capabilities: Object.freeze({formatVersion: 1, workspaceId, durability: 'file-fsync-rename', directoryFsync: process.platform !== 'win32', singleWriter: true, limits: WORKSPACE_EDIT_LIMITS}),
    begin(record) {let valid; try {valid = parseWorkspaceEditRecord(record);} catch (error) {return Promise.reject(mapped(error));} return schedule(() => save(valid, true));},
    write(record) {let valid; try {valid = parseWorkspaceEditRecord(record);} catch (error) {return Promise.reject(mapped(error));} return schedule(() => save(valid, false));},
    read(id) {try {requireUuid(id);} catch (error) {return Promise.reject(mapped(error));} return schedule(() => read(id));},
    list() {return schedule(async () => {await checkOwned(); const items = []; for (const id of sizes.keys()) {try {const record = await read(id); items.push({planId: id, phase: record.phase, revision: record.revision, available: true});} catch (error) {items.push({planId: id, available: false, errorCode: mapped(error).code});}} return editCopy(items);});},
    close() {if (closePromise) return closePromise; closing = true; closePromise = tail.then(release).catch(error => {throw mapped(error);}).finally(() => {closed = true;}); return closePromise;},
  });
}
