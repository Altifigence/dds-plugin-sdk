import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPluginHost, definePlugin} from '../src/index.mjs';
import {createNodeJobStore} from '../src/job-storage-node.mjs';
import {parseStoredJob, parseJobRecovery, parseJobStorageCapabilities, JOB_STORE_LIMITS} from '../src/job-storage.mjs';
import {deferred} from './fixtures.mjs';

const artifact = 'a'.repeat(64);
const manifest = {manifestVersion:2,id:'stored-jobs',name:'Stored jobs',publisher:'example',version:'1.0.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:['workspace.read','backend.invoke'],supportedHosts:['test-host','workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const digest = value => createHash('sha256').update(value).digest('hex');
const encode = record => JSON.stringify({formatVersion:1,sha256:digest(JSON.stringify(record)),record});
async function fixture(t, options = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dds-job-storage-')));
  const workspaceRoot = path.join(temporary, 'project'), directory = path.join(temporary, 'store'), workspaceId = randomUUID();
  await fs.mkdir(workspaceRoot);
  const stores = [], hosts = [];
  const config = {directory, workspaceRoot, workspaceId, ...options};
  async function open(overrides = {}) {const store = await createNodeJobStore({...config, ...overrides}); stores.push(store); return store;}
  async function host(store, handler = () => null, extra = {}) {
    const instance = createPluginHost({jobs:true,scope:{projectId:workspaceId,sessionId:randomUUID()},grants:['workspace.read','backend.invoke'],jobStorage:{store,workspaceIdentity:store.identity.workspaceIdentity,pluginArtifacts:{[manifest.id]:artifact}},...extra});
    hosts.push(instance); await instance.activate(definePlugin(manifest, context => context.registerCommand({id:'run',title:'Run'}, handler)));
    return instance;
  }
  t.after(async () => {
    for (const instance of hosts) instance.dispose();
    for (const instance of hosts) await instance.flushJobStore().catch(() => {});
    for (const store of stores) await store.close().catch(() => {});
    assert.equal(await fs.realpath(temporary), temporary);
    assert.ok(path.basename(temporary).startsWith('dds-job-storage-'));
    await fs.rm(temporary, {recursive:true});
  });
  return {temporary, workspaceRoot, directory, workspaceId, config, open, host};
}
async function finished(host, id) {
  const deadline = Date.now() + 5000;
  for (;;) {
    await host.flushJobStore();
    const result = host.recoverJob(manifest.id, id);
    if (result.record?.settled) return result;
    if (Date.now() > deadline) throw Error('Stored job did not settle');
    await delay(5);
  }
}
function stored(identity, jobId = randomUUID(), revision = 1) {
  const now = Date.now(), scope = {projectId:identity.workspaceId,sessionId:randomUUID()};
  return {...identity,pluginArtifactSha256:artifact,requestSha256:'b'.repeat(64),revision,savedAt:now,expiresAt:now+60000,settled:false,contentPolicy:'metadata-only',grants:['workspace.read'],snapshot:{protocolVersion:1,jobId,scope,pluginId:manifest.id,commandId:'run',state:'running',startedAt:now,updatedAt:now,timeoutMs:5000,progress:null,artifacts:[],lastSequence:1},events:[{sequence:1,at:now,kind:'state',data:{state:'running'}}],binaryArtifacts:[]};
}

test('storage is opt-in and validators reject hooks, oversized records and inconsistent identities', async t => {
  const host = createPluginHost({jobs:true}); t.after(() => host.dispose());
  assert.equal(parseJobStorageCapabilities(host.jobStorageCapabilities()).enabled, false);
  const f = await fixture(t), store = await f.open(), record = stored(store.identity);
  assert.equal(parseStoredJob(record).snapshot.jobId, record.snapshot.jobId);
  let hooks = 0;
  assert.throws(() => parseStoredJob({...record,get snapshot(){hooks++;return record.snapshot;}})); assert.equal(hooks, 0);
  for (const changed of [{schemaVersion:2},{revision:0},{workspaceId:'other'},{savedAt:0},{events:[]},{settled:true},{extra:true}]) assert.throws(() => parseStoredJob({...record,...changed}));
  const events = structuredClone(record.events); events[0].sequence = 2; assert.throws(() => parseStoredJob({...record,events}));
  const current = {protocolVersion:1,jobId:record.snapshot.jobId,scope:record.snapshot.scope,storeId:record.storeId,disposition:'interrupted',unrecordedTail:'unknown',record};
  assert.equal(parseJobRecovery(current).disposition,'interrupted');
  assert.throws(() => parseJobRecovery({...current,disposition:'completed'}));
});

test('checkpointed jobs retain metadata without raw input, result, progress or log secrets', async t => {
  const f = await fixture(t), store = await f.open();
  const host = await f.host(store, (input,{job}) => {job.log('info', 'secret-log');job.reportProgress({completed:1,total:1,message:'secret-progress'});return{secret:input.secret};});
  const job = host.startCommandJob(manifest.id,'run',{secret:'secret-input'},{jobId:randomUUID()});
  assert.equal(job.state,'running');
  const recovery = await finished(host,job.jobId);
  assert.equal(recovery.disposition,'completed'); assert.equal(recovery.record.snapshot.state,'succeeded'); assert.equal(recovery.record.snapshot.result,null);
  assert.equal(recovery.record.contentPolicy,'metadata-only');
  const file = await fs.readFile(path.join(f.directory,'jobs',job.jobId+'.json'),'utf8');
  for (const secret of ['secret-log','secret-progress','secret-input']) assert.ok(!file.includes(secret));
  assert.equal(recovery.record.events.find(event=>event.kind==='log').data.message,'[redacted]');
  assert.equal(recovery.record.snapshot.progress.message,undefined);
  assert.ok(recovery.record.revision>=1); assert.ok(Object.isFrozen(recovery.record));
});

test('a reviewed host redactor retains safe messages and results and fails closed on invalid output', async t => {
  const f = await fixture(t), store = await f.open();
  const host = await f.host(store, (_,{job})=>{job.log('info','private 123');job.reportProgress({completed:1,total:1,message:'private 123'});return{private:123};},{jobStorage:{store,workspaceIdentity:store.identity.workspaceIdentity,pluginArtifacts:{[manifest.id]:artifact},redact:entry=>entry.kind==='result'?{ok:true}:'reviewed'}});
  const result = await finished(host,host.startCommandJob(manifest.id,'run',{}, {jobId:randomUUID()}).jobId);
  assert.deepEqual(result.record.snapshot.result,{ok:true}); assert.equal(result.record.snapshot.progress.message,'reviewed'); assert.equal(result.record.events.find(e=>e.kind==='log').data.message,'reviewed');
  host.dispose(); await host.flushJobStore(); await store.close();
  const reopened = await f.open();
  const reviewed=deferred();
  const bad = await f.host(reopened,(_,{job})=>{job.log('info','never saved');return null;},{jobStorage:{store:reopened,workspaceIdentity:reopened.identity.workspaceIdentity,pluginArtifacts:{[manifest.id]:artifact},redact:()=>{reviewed.resolve();return{get secret(){throw Error('must not execute');}};}}});
  bad.startCommandJob(manifest.id,'run',{}, {jobId:randomUUID()});
  await Promise.race([reviewed.promise,delay(5000,undefined,{ref:false}).then(()=>{throw Error('Redactor was not called');})]);
  await assert.rejects(bad.flushJobStore(),{code:'invalid_contract'});
});

test('restart rebinds the current scope and grants without replaying a previous job ID', async t => {
  const f = await fixture(t), store = await f.open(); let executions = 0;
  const first = await f.host(store,()=>{executions++;return true;});
  const job = first.startCommandJob(manifest.id,'run',{}, {jobId:randomUUID()}); const saved = await finished(first,job.jobId);
  first.dispose(); await first.flushJobStore(); await store.close();
  const reopened = await f.open(), next = await f.host(reopened,()=>{executions++;return true;});
  const recovered = next.recoverJob(manifest.id,job.jobId);
  assert.equal(recovered.disposition,'completed'); assert.notEqual(recovered.scope.sessionId,saved.scope.sessionId); assert.equal(recovered.record.snapshot.scope.sessionId,saved.scope.sessionId);
  assert.throws(()=>next.startCommandJob(manifest.id,'run',{}, {jobId:job.jobId}),{code:'conflict'}); assert.equal(executions,1);
  next.dispose(); await reopened.close();
  const revokedStore = await f.open(), revoked = await f.host(revokedStore,()=>null,{grants:['workspace.read']});
  assert.throws(()=>revoked.recoverJob(manifest.id,job.jobId),{code:'permission_denied'});
});

test('current artifact, command, workspace and activation are required for recovery', async t => {
  const f = await fixture(t), store = await f.open(), host = await f.host(store);
  const job = host.startCommandJob(manifest.id,'run',{}, {jobId:randomUUID()}); await finished(host,job.jobId); host.dispose(); await host.flushJobStore(); await store.close();
  const nextStore = await f.open(), next = await f.host(nextStore,()=>null,{jobStorage:{store:nextStore,workspaceIdentity:nextStore.identity.workspaceIdentity,pluginArtifacts:{[manifest.id]:'c'.repeat(64)}}});
  assert.throws(()=>next.recoverJob(manifest.id,job.jobId),{code:'conflict'}); next.deactivate(manifest.id); assert.throws(()=>next.recoverJob(manifest.id,job.jobId),{code:'disposed'});
  await nextStore.close();
  await assert.rejects(f.open({workspaceId:randomUUID()}),{code:'conflict'});
  const valid = await f.open(); assert.equal(valid.get(job.jobId).snapshot.jobId,job.jobId);
  assert.throws(()=>createPluginHost({jobs:true,scope:{projectId:f.workspaceId,sessionId:randomUUID()},jobStorage:{store:valid,workspaceIdentity:'f'.repeat(64),pluginArtifacts:{[manifest.id]:artifact}}}),{code:'conflict'});
});

test('single writer, CAS, idempotent writes, quotas, expiry and explicit pruning are bounded', async t => {
  const f = await fixture(t,{maxRecords:1}), store = await f.open();
  await assert.rejects(f.open(),{code:'conflict'}); await assert.rejects(f.open({recoverStaleLock:true}),{code:'conflict'});
  const record = stored(store.identity); await store.write(record,0); assert.deepEqual(await store.write(record,0),parseStoredJob(record));
  await assert.rejects(store.write({...record,revision:2},0),{code:'conflict'});
  await assert.rejects(store.write(stored(store.identity),0),{code:'budget_exceeded'});
  const release = store.pin(record.snapshot.jobId); await assert.rejects(store.remove(record.snapshot.jobId,1),{code:'conflict'});
  const now = record.expiresAt+1; t.mock.method(Date,'now',()=>now);
  assert.deepEqual((await store.prune()).retained,[record.snapshot.jobId]); release();
  assert.deepEqual((await store.prune()).removed,[record.snapshot.jobId]); assert.equal(store.has(record.snapshot.jobId),false);
  await store.write(stored(store.identity),0); assert.equal(store.inspect().records,1);
});

test('initial persistence failure prevents provider execution and is observable on flush', async t => {
  const f = await fixture(t,{maxBytes:100}), store = await f.open(); let calls=0;
  const host = await f.host(store,()=>{calls++;return null;}); host.startCommandJob(manifest.id,'run',{}, {jobId:randomUUID()});
  await assert.rejects(host.flushJobStore(),{code:'budget_exceeded'}); await delay(10); assert.equal(calls,0); assert.equal(store.inspect().records,0);
});

test('provider execution waits for a real committed start checkpoint', async t => {
  const f=await fixture(t),store=await f.open(),entered=deferred(),release=deferred();let calls=0,first=true;
  const delayed={...store,async write(record,expected){if(first){first=false;entered.resolve();await release.promise;}return store.write(record,expected);}};
  const host=await f.host(delayed,()=>{calls++;return true;});
  const id=host.startCommandJob(manifest.id,'run',{}, {jobId:randomUUID()}).jobId;
  await entered.promise;assert.equal(calls,0);assert.equal(store.has(id),false);release.resolve();
  await finished(host,id);assert.equal(calls,1);
});

test('a corrupt or unsupported record does not hide valid neighbors or become a new execution', async t => {
  const f = await fixture(t), store = await f.open(), valid = stored(store.identity), bad = stored(store.identity), future = stored(store.identity);
  for(const record of [valid,bad,future])await store.write(record,0); await store.close();
  await fs.writeFile(path.join(f.directory,'jobs',bad.snapshot.jobId+'.json'),'{torn write');
  await fs.writeFile(path.join(f.directory,'jobs',future.snapshot.jobId+'.json'),encode({...future,schemaVersion:2}));
  const reopened = await f.open(), host = await f.host(reopened);
  assert.equal(reopened.get(valid.snapshot.jobId).snapshot.jobId,valid.snapshot.jobId); assert.equal(reopened.inspect().problems.length,2);
  assert.equal(host.recoverJob(manifest.id,bad.snapshot.jobId).disposition,'corrupt'); assert.equal(host.recoverJob(manifest.id,future.snapshot.jobId).disposition,'unsupported');
  assert.throws(()=>host.startCommandJob(manifest.id,'run',{}, {jobId:bad.snapshot.jobId}),{code:'conflict'});
});

test('explicit legacy import verifies the new contract and preserves exact original bytes on failure', async t => {
  const f = await fixture(t), store = await f.open(), record = stored(store.identity); await store.write(record,0); await store.close();
  const file = path.join(f.directory,'jobs',record.snapshot.jobId+'.json'), legacy = {...record,schemaVersion:0}, original = encode(legacy); await fs.writeFile(file,original);
  const rejected = await f.open({migrateLegacy:()=>({invalid:true})}); assert.equal(rejected.inspect().problems.length,1); await rejected.close(); assert.equal(await fs.readFile(file,'utf8'),original);
  const migrated = await f.open({migrateLegacy:value=>({...value,schemaVersion:1})}); assert.equal(migrated.get(record.snapshot.jobId).schemaVersion,1);
  assert.equal(await fs.readFile(file+'.legacy-backup','utf8'),original); assert.equal(migrated.inspect().migrationBackups,1);
});

test('workspace-contained storage, replaced records and hardlinks are rejected without outside writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.open({directory:path.join(f.workspaceRoot,'store')}),{code:'invalid_contract'});
  const store = await f.open(), record = stored(store.identity); await store.write(record,0);
  const file = path.join(f.directory,'jobs',record.snapshot.jobId+'.json'), outside = path.join(f.temporary,'outside.json'); await fs.link(file,outside);
  await assert.rejects(store.write({...record,revision:2},1),{code:'invalid_contract'}); const original=await fs.readFile(outside,'utf8'); await fs.unlink(file); await fs.writeFile(file,'tampered');
  await assert.rejects(store.write({...record,revision:2},1)); assert.equal(await fs.readFile(outside,'utf8'),original);
});

test('coalesced event bursts keep the durable ring bounded and record clock rollback monotonically', async t => {
  const f = await fixture(t), store = await f.open(); const start = Date.now(); let now=start;
  t.mock.method(Date,'now',()=>now);
  const host = await f.host(store,(_,{job})=>{for(let i=0;i<1000;i++)job.log('info','event '+i);now=start-5000;job.reportProgress({completed:1,total:1});return null;});
  const id=host.startCommandJob(manifest.id,'run',{}, {jobId:randomUUID()}).jobId, result=await finished(host,id);
  assert.ok(result.record.events.length<=256); assert.equal(result.record.events.at(-1).sequence,result.record.snapshot.lastSequence); assert.ok(result.record.savedAt>=result.record.snapshot.updatedAt); assert.ok(result.record.revision<30);
});

test('an incomplete temporary checkpoint does not replace the last committed record', async t => {
  const f=await fixture(t),store=await f.open(),record=stored(store.identity);await store.write(record,0);await store.close();
  await fs.writeFile(path.join(f.directory,'jobs','.checkpoint-'+record.storeId+'-'+randomUUID()),'{incomplete');
  const reopened=await f.open(),host=await f.host(reopened),recovered=host.recoverJob(manifest.id,record.snapshot.jobId);
  assert.equal(recovered.disposition,'interrupted');assert.equal(recovered.unrecordedTail,'unknown');assert.equal(recovered.record.revision,1);assert.equal(reopened.inspect().orphanCount,1);
});

test('the public example survives real clean exit and forced child termination', () => {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../examples/durable-jobs/run.mjs',import.meta.url))],{encoding:'utf8',timeout:30000,maxBuffer:32768,windowsHide:true});
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/killed child, current authorization and no automatic replay verified/);
});

test('workspace and store directory replacement deny writes until original identities return', async t => {
  const f=await fixture(t),store=await f.open(),record=stored(store.identity);
  const movedProject=path.join(f.temporary,'original-project');
  await fs.rename(f.workspaceRoot,movedProject);await fs.mkdir(f.workspaceRoot);
  await assert.rejects(store.write(record,0),{code:'conflict'});
  await fs.rmdir(f.workspaceRoot);await fs.rename(movedProject,f.workspaceRoot);
  const movedStore=path.join(f.temporary,'original-store');
  await fs.rename(f.directory,movedStore);await fs.mkdir(f.directory);
  await assert.rejects(store.write(record,0),{code:'conflict'});
  assert.deepEqual(await fs.readdir(f.directory),[]);
  await fs.rmdir(f.directory);await fs.rename(movedStore,f.directory);
  await store.write(record,0);assert.equal(store.get(record.snapshot.jobId).revision,1);
});

test('a final checkpoint remains pinned until its commit finishes', async t => {
  const f=await fixture(t),store=await f.open(),entered=deferred(),release=deferred();
  const delayed={...store,async write(record,expected){if(record.settled){entered.resolve(record);await release.promise;}return store.write(record,expected);}};
  const host=await f.host(delayed,()=>true),id=host.startCommandJob(manifest.id,'run',{}, {jobId:randomUUID()}).jobId;
  await entered.promise;
  const old=store.get(id);assert.ok(old);
  await assert.rejects(store.remove(id,old.revision),{code:'conflict'});
  release.resolve();await finished(host,id);
  await store.remove(id,store.get(id).revision);assert.equal(store.get(id),null);
});
