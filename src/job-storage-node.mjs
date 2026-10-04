import * as fs from 'node:fs/promises';
import {constants as flags} from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {parseJobId} from './jobs.mjs';
import {ErrorCode, PluginSdkError} from './limits.mjs';
import {DEFAULT_JOB_RETENTION_MS, JOB_STORE_LIMITS, parseJobStoreIdentity, parseJobStoreLimits, parseStoredJob} from './job-storage.mjs';
import {storageInteger, storageObject} from './job-storage-validation.mjs';
import {nodeWorkspaceIdentity} from './workspace-identity-node.mjs';
import {registerNodeStore} from './node-store-context.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const failure = code => new PluginSdkError(code, 'Job store operation failed');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const contained = (root, target) => {const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);};
const recordName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/;
function mapped(error) {
  if (error instanceof PluginSdkError) return error;
  if (['EEXIST', 'ENOTEMPTY'].includes(error?.code)) return failure(ErrorCode.CONFLICT);
  if (['EACCES', 'EPERM'].includes(error?.code)) return failure(ErrorCode.PERMISSION_DENIED);
  if (['ENOSPC', 'EDQUOT', 'EFBIG'].includes(error?.code)) return failure(ErrorCode.BUDGET_EXCEEDED);
  return failure(ErrorCode.PROVIDER_FAILED);
}
async function realDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw failure(ErrorCode.INVALID_CONTRACT);
  const supplied = await fs.lstat(value, {bigint: true});
  if (!supplied.isDirectory() || supplied.isSymbolicLink()) throw failure(ErrorCode.INVALID_CONTRACT);
  const canonical = await fs.realpath(value), stat = await fs.lstat(canonical, {bigint: true});
  return {canonical, stat};
}
async function regularBytes(file, maximum) {
  const before = await fs.lstat(file, {bigint: true});
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) throw failure(ErrorCode.INVALID_CONTRACT);
  const handle = await fs.open(file, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({bigint: true});
    if (!same(opened, before) || !opened.isFile() || opened.nlink !== 1n) throw failure(ErrorCode.CONFLICT);
    const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
    while (offset < bytes.length) {const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) throw failure(ErrorCode.CONFLICT); offset += result.bytesRead;}
    const after = await handle.stat({bigint: true}), current = await fs.lstat(file, {bigint: true});
    if (!same(after, opened) || !same(current, opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs || current.isSymbolicLink() || current.nlink !== 1n) throw failure(ErrorCode.CONFLICT);
    return bytes;
  } finally {await handle.close();}
}
const decode = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const envelope = record => JSON.stringify({formatVersion: 1, sha256: digest(JSON.stringify(record)), record});
function unwrap(bytes) {
  const value = decode(bytes); storageObject(value, ['formatVersion', 'sha256', 'record']);
  if (value.formatVersion !== 1) throw failure(ErrorCode.VERSION_MISMATCH);
  if (typeof value.sha256 !== 'string' || value.sha256 !== digest(JSON.stringify(value.record))) throw failure(ErrorCode.CONFLICT);
  return value.record;
}
function owner(value) {
  storageObject(value, ['pid', 'host', 'token']); storageInteger(value.pid, 1); parseJobId(value.token);
  if (typeof value.host !== 'string' || !value.host || value.host.length > 256) throw failure(ErrorCode.INVALID_CONTRACT);
  return value;
}
function definitelyDead(value) {
  if (value.host !== hostname() || value.pid === process.pid) return false;
  try {process.kill(value.pid, 0); return false;} catch (error) {return error?.code === 'ESRCH';}
}

/** A local, single-writer store outside the workspace. Not a network filesystem lock or an OS sandbox. */
export async function createNodeJobStore({directory, workspaceRoot, workspaceId, retentionMs = DEFAULT_JOB_RETENTION_MS, maxRecords = JOB_STORE_LIMITS.records, maxBytes = JOB_STORE_LIMITS.storeBytes, recoverStaleLock = false, migrateLegacy} = {}) {
  const limits = parseJobStoreLimits({...JOB_STORE_LIMITS, records: maxRecords, storeBytes: maxBytes, retentionMs});
  if (typeof recoverStaleLock !== 'boolean' || migrateLegacy !== undefined && typeof migrateLegacy !== 'function') throw failure(ErrorCode.INVALID_CONTRACT);
  // Validate the logical ID before creating anything on disk.
  parseJobStoreIdentity({schemaVersion: 1, storeId: randomUUID(), workspaceId, workspaceIdentity: '0'.repeat(64)});
  let root, jobsDirectory, initial, jobsInitial, identity, lockToken, workspaceBinding, closePromise, closed = false, closing = false, directorySynced = false;
  let tail = Promise.resolve(), queued = 0, usedBytes = 0;
  const records = new Map(), problems = new Map(), sizes = new Map(), pins = new Map(), migrationBackups = [], orphanFiles = [];
  const currentOwner = {pid: process.pid, host: hostname(), token: randomUUID()};
  async function checkRoot(checkWorkspace = true) {
    const now = await fs.lstat(root, {bigint: true});
    if (!now.isDirectory() || now.isSymbolicLink() || !same(now, initial) || await fs.realpath(root) !== root) throw failure(ErrorCode.CONFLICT);
    if (checkWorkspace) {
      const workspaceNow = await realDirectory(workspaceRoot);
      if (nodeWorkspaceIdentity(workspaceNow.canonical, workspaceNow.stat) !== workspaceBinding) throw failure(ErrorCode.CONFLICT);
    }
  }
  async function checkOwned(checkWorkspace = true) {
    if (closed) throw failure(ErrorCode.DISPOSED);
    await checkRoot(checkWorkspace);
    const own = owner(decode(await regularBytes(path.join(root, '.writer.lock'), 2048)));
    if (own.token !== lockToken || own.pid !== process.pid || own.host !== hostname()) throw failure(ErrorCode.CONFLICT);
    if (jobsInitial) {
      const now = await fs.lstat(jobsDirectory, {bigint: true});
      if (!now.isDirectory() || now.isSymbolicLink() || !same(now, jobsInitial) || await fs.realpath(jobsDirectory) !== jobsDirectory) throw failure(ErrorCode.CONFLICT);
    }
  }
  async function syncDirectory(target) {
    // Windows does not provide the same directory fsync contract through this API.
    if (process.platform === 'win32') {directorySynced = false; return;}
    const handle = await fs.open(target, flags.O_RDONLY | (flags.O_NOFOLLOW ?? 0));
    try {await handle.sync(); directorySynced = true;} finally {await handle.close();}
  }
  async function exclusive(file, bytes) {
    const handle = await fs.open(file, flags.O_WRONLY | flags.O_CREAT | flags.O_EXCL | (flags.O_NOFOLLOW ?? 0), 0o600);
    try {await handle.writeFile(bytes); await handle.sync();} finally {await handle.close();}
  }
  async function atomic(file, bytes) {
    await checkOwned();
    const temporary = path.join(path.dirname(file), '.checkpoint-' + identity.storeId + '-' + randomUUID());
    let created = false;
    try {
      await exclusive(temporary, bytes); created = true; await checkOwned();
      // The destination must remain a single regular file, or be absent.
      try {await regularBytes(file, JOB_STORE_LIMITS.recordBytes + 2048);} catch (error) {if (error.code !== 'ENOENT') throw error;}
      await fs.rename(temporary, file); created = false; await syncDirectory(path.dirname(file)); await checkOwned();
    } finally {
      if (created) {await checkOwned(); await regularBytes(temporary, JOB_STORE_LIMITS.recordBytes + 2048); await fs.unlink(temporary);}
    }
  }
  async function acquire() {
    const lock = path.join(root, '.writer.lock'), recovery = path.join(root, '.recovery.lock');
    try {await fs.lstat(recovery); throw failure(ErrorCode.CONFLICT);} catch (error) {if (error.code !== 'ENOENT') throw error;}
    try {await exclusive(lock, JSON.stringify(currentOwner)); lockToken = currentOwner.token;}
    catch (error) {
      if (error.code !== 'EEXIST' || !recoverStaleLock) throw error;
      const previous = owner(decode(await regularBytes(lock, 2048)));
      if (!definitelyDead(previous)) throw failure(ErrorCode.CONFLICT);
      // Only one recovery operation may remove a dead writer's lock. A writer
      // rechecks this guard after acquiring, before it can read or change data.
      await exclusive(recovery, JSON.stringify(currentOwner));
      try {
        await checkRoot();
        const confirmed = owner(decode(await regularBytes(lock, 2048)));
        if (confirmed.token !== previous.token || !definitelyDead(confirmed)) throw failure(ErrorCode.CONFLICT);
        await fs.unlink(lock); await exclusive(lock, JSON.stringify(currentOwner)); lockToken = currentOwner.token;
      } finally {
        const guard = owner(decode(await regularBytes(recovery, 2048)));
        if (guard.token !== currentOwner.token) throw failure(ErrorCode.CONFLICT);
        await fs.unlink(recovery);
      }
    }
    try {await fs.lstat(recovery); throw failure(ErrorCode.CONFLICT);} catch (error) {if (error.code !== 'ENOENT') throw error;}
    await syncDirectory(root);
  }
  async function release() {
    if (!lockToken) return;
    await checkOwned(false); await fs.unlink(path.join(root, '.writer.lock')); lockToken = undefined; await syncDirectory(root);
  }
  try {
    const workspace = await realDirectory(workspaceRoot);
    workspaceBinding = nodeWorkspaceIdentity(workspace.canonical, workspace.stat);
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw failure(ErrorCode.INVALID_CONTRACT);
    const parent = await realDirectory(path.dirname(directory));
    const requested = path.join(parent.canonical, path.basename(directory));
    if (contained(workspace.canonical, requested) || contained(requested, workspace.canonical)) throw failure(ErrorCode.INVALID_CONTRACT);
    try {await fs.mkdir(requested, {mode: 0o700});} catch (error) {if (error.code !== 'EEXIST') throw error;}
    const resolved = await realDirectory(requested); root = resolved.canonical; initial = resolved.stat;
    if (contained(workspace.canonical, root) || contained(root, workspace.canonical)) throw failure(ErrorCode.INVALID_CONTRACT);
    await acquire();
    const manifest = path.join(root, 'store.json'), workspaceIdentity = nodeWorkspaceIdentity(workspace.canonical, workspace.stat);
    try {
      identity = parseJobStoreIdentity(decode(await regularBytes(manifest, 2048)));
      if (identity.workspaceId !== workspaceId || identity.workspaceIdentity !== workspaceIdentity) throw failure(ErrorCode.CONFLICT);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if ((await fs.readdir(root)).some(name => name !== '.writer.lock')) throw failure(ErrorCode.CONFLICT);
      identity = parseJobStoreIdentity({schemaVersion: 1, storeId: randomUUID(), workspaceId, workspaceIdentity});
      await atomic(manifest, JSON.stringify(identity));
    }
    jobsDirectory = path.join(root, 'jobs');
    try {await fs.mkdir(jobsDirectory, {mode: 0o700}); await syncDirectory(root);} catch (error) {if (error.code !== 'EEXIST') throw error;}
    const resolvedJobs = await realDirectory(jobsDirectory); jobsInitial = resolvedJobs.stat;
    if (resolvedJobs.canonical !== jobsDirectory) throw failure(ErrorCode.CONFLICT);
    const names = await fs.readdir(jobsDirectory);
    if (names.length > limits.records * 3 + limits.pendingWrites) throw failure(ErrorCode.BUDGET_EXCEEDED);
    for (const name of names) {const stat = await fs.lstat(path.join(jobsDirectory, name), {bigint: true}); usedBytes += Number(stat.size); sizes.set(name, Number(stat.size));}
    if (usedBytes > limits.storeBytes) throw failure(ErrorCode.BUDGET_EXCEEDED);
    for (const name of names) {
      const file = path.join(jobsDirectory, name);
      const previousSize = sizes.get(name);
      if (name.startsWith('.checkpoint-' + identity.storeId + '-')) {orphanFiles.push(name); continue;}
      if (name.endsWith('.legacy-backup')) {migrationBackups.push(name); continue;}
      if (!recordName.test(name)) throw failure(ErrorCode.INVALID_CONTRACT);
      const jobId = name.slice(0, -5);
      try {
        const bytes = await regularBytes(file, JOB_STORE_LIMITS.recordBytes + 2048);
        let record = unwrap(bytes);
        if (record?.schemaVersion === 0 && migrateLegacy) {
          // Version zero is an explicitly configured operator import format, not
          // a claimed historical SDK release. Always preserve its exact bytes.
          const migrated = parseStoredJob(await migrateLegacy(record, identity));
          if (migrated.snapshot.jobId !== jobId || migrated.storeId !== identity.storeId || migrated.workspaceId !== workspaceId || migrated.workspaceIdentity !== workspaceIdentity) throw failure(ErrorCode.CONFLICT);
          const backup = name + '.legacy-backup', backupFile = path.join(jobsDirectory, backup);
          const next = envelope(migrated), nextSize = Buffer.byteLength(next);
          if (usedBytes - previousSize + nextSize + (sizes.has(backup) ? 0 : bytes.length) > limits.storeBytes) throw failure(ErrorCode.BUDGET_EXCEEDED);
          try {await exclusive(backupFile, bytes); usedBytes += bytes.length; sizes.set(backup, bytes.length); migrationBackups.push(backup);}
          catch (error) {if (error.code !== 'EEXIST' || !Buffer.from(await regularBytes(backupFile, JOB_STORE_LIMITS.recordBytes + 2048)).equals(bytes)) throw error;}
          await atomic(file, next); usedBytes += nextSize - previousSize; sizes.set(name, nextSize); record = migrated;
        }
        record = parseStoredJob(record);
        if (record.snapshot.jobId !== jobId || record.storeId !== identity.storeId || record.workspaceId !== workspaceId || record.workspaceIdentity !== workspaceIdentity) throw failure(ErrorCode.CONFLICT);
        records.set(jobId, record);
      } catch (error) {problems.set(jobId, error.code === ErrorCode.VERSION_MISMATCH ? 'unsupported' : 'corrupt');}
    }
    if (records.size + problems.size > limits.records || usedBytes > limits.storeBytes) throw failure(ErrorCode.BUDGET_EXCEEDED);
  } catch (error) {
    if (lockToken) await release().catch(() => {});
    throw mapped(error);
  }

  const assertOpen = () => {if (closed || closing) throw failure(ErrorCode.DISPOSED);};
  function enqueue(operation) {
    assertOpen(); if (queued >= limits.pendingWrites) throw failure(ErrorCode.BUDGET_EXCEEDED);
    queued++;
    const result = tail.then(async () => {await checkOwned(); return operation();}).catch(error => {throw mapped(error);}).finally(() => {queued--;});
    tail = result.catch(() => {}); return result;
  }
  async function unchanged(jobId) {
    const file = path.join(jobsDirectory, jobId + '.json'), old = records.get(jobId);
    if (old) {const current = parseStoredJob(unwrap(await regularBytes(file, JOB_STORE_LIMITS.recordBytes + 2048))); if (JSON.stringify(current) !== JSON.stringify(old)) throw failure(ErrorCode.CONFLICT);}
    else {try {await fs.lstat(file); throw failure(ErrorCode.CONFLICT);} catch (error) {if (error.code !== 'ENOENT') throw error;}}
  }
  async function removeRecord(jobId) {
    await unchanged(jobId); await checkOwned();
    const name = jobId + '.json'; await fs.unlink(path.join(jobsDirectory, name)); await syncDirectory(jobsDirectory);
    usedBytes -= sizes.get(name) ?? 0; sizes.delete(name); records.delete(jobId);
  }
  const store = Object.freeze({
    identity, limits,
    has(jobId) {assertOpen(); parseJobId(jobId); return records.has(jobId) || problems.has(jobId);},
    get(jobId) {assertOpen(); parseJobId(jobId); if (problems.has(jobId)) throw failure(problems.get(jobId) === 'unsupported' ? ErrorCode.VERSION_MISMATCH : ErrorCode.CONFLICT); return records.get(jobId) ?? null;},
    entries() {assertOpen(); return Object.freeze([...records.values()]);},
    pin(jobId) {
      assertOpen(); parseJobId(jobId); pins.set(jobId, (pins.get(jobId) ?? 0) + 1); let released = false;
      return () => {if (released) return; released = true; const remaining = (pins.get(jobId) ?? 1) - 1; if (remaining) pins.set(jobId, remaining); else pins.delete(jobId);};
    },
    write(value, expectedRevision) {
      const record = parseStoredJob(value); storageInteger(expectedRevision);
      return enqueue(async () => {
        const jobId = record.snapshot.jobId, old = records.get(jobId), previousRevision = old?.revision ?? 0;
        if (record.storeId !== identity.storeId || record.workspaceId !== identity.workspaceId || record.workspaceIdentity !== identity.workspaceIdentity || problems.has(jobId)) throw failure(ErrorCode.CONFLICT);
        if (old && record.revision === old.revision && JSON.stringify(record) === JSON.stringify(old) && expectedRevision === old.revision - 1) {await unchanged(jobId); return old;}
        if (previousRevision !== expectedRevision || record.revision !== expectedRevision + 1) throw failure(ErrorCode.CONFLICT);
        if (old && (old.settled || record.requestSha256 !== old.requestSha256 || record.pluginArtifactSha256 !== old.pluginArtifactSha256 || record.snapshot.pluginId !== old.snapshot.pluginId || record.snapshot.commandId !== old.snapshot.commandId || JSON.stringify(record.snapshot.scope) !== JSON.stringify(old.snapshot.scope) || record.snapshot.startedAt !== old.snapshot.startedAt || record.savedAt < old.savedAt || record.snapshot.lastSequence < old.snapshot.lastSequence || record.attemptOf !== old.attemptOf || record.contentPolicy !== old.contentPolicy || JSON.stringify(record.grants) !== JSON.stringify(old.grants) || old.snapshot.state !== 'running' && record.snapshot.state !== old.snapshot.state)) throw failure(ErrorCode.CONFLICT);
        if (old) {
          const retained = new Map(record.events.map(event => [event.sequence, event]));
          for (const event of old.events) if (retained.has(event.sequence) && JSON.stringify(retained.get(event.sequence)) !== JSON.stringify(event)) throw failure(ErrorCode.CONFLICT);
          for(const artifact of old.retainedArtifacts??[])if(!record.retainedArtifacts?.some(next=>JSON.stringify(next)===JSON.stringify(artifact)))throw failure(ErrorCode.CONFLICT);
        }
        const bytes = envelope(record), size = Buffer.byteLength(bytes), name = jobId + '.json';
        if (!old && records.size + problems.size >= limits.records || usedBytes - (sizes.get(name) ?? 0) + size > limits.storeBytes) throw failure(ErrorCode.BUDGET_EXCEEDED);
        await unchanged(jobId); await atomic(path.join(jobsDirectory, name), bytes);
        usedBytes += size - (sizes.get(name) ?? 0); sizes.set(name, size); records.set(jobId, record); return record;
      });
    },
    remove(jobId, expectedRevision) {
      parseJobId(jobId); storageInteger(expectedRevision, 1);
      return enqueue(async () => {const old = records.get(jobId); if (!old || old.revision !== expectedRevision || pins.has(jobId)) throw failure(ErrorCode.CONFLICT); await removeRecord(jobId); return Object.freeze({jobId, removed: true});});
    },
    prune() {
      return enqueue(async () => {
        const now = Date.now(), removed = [], retained = [];
        for (const [jobId, record] of records) if (record.expiresAt <= now) {
          if (pins.has(jobId)) retained.push(jobId); else {await removeRecord(jobId); removed.push(jobId);}
        }
        return Object.freeze({removed: Object.freeze(removed), retained: Object.freeze(retained), bytes: usedBytes});
      });
    },
    inspect() {
      assertOpen(); return Object.freeze({identity, records: records.size, bytes: usedBytes, expired: Object.freeze([...records.values()].filter(r => r.expiresAt <= Date.now()).map(r => r.snapshot.jobId)), problems: Object.freeze([...problems].map(([jobId, disposition]) => Object.freeze({jobId, disposition}))), orphanCount: orphanFiles.length, migrationBackups: migrationBackups.length, durability: directorySynced ? 'file-and-directory-sync' : 'file-sync-and-rename'});
    },
    async flush() {if (closed) throw failure(ErrorCode.DISPOSED); await tail; await checkOwned();},
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {try {await tail; await release();} finally {closed = true; pins.clear();}})();
      return closePromise;
    },
  });
  registerNodeStore(store, {root, enqueue, checkOwned, syncDirectory, regularBytes, atomic, isJobPinned: jobId => pins.has(jobId)});
  return store;
}
