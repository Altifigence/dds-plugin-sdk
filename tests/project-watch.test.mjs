import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createNodeWorkspace} from '../src/workspace-node.mjs';
import {createNodeProjectWatcher} from '../src/project-watch-node.mjs';
import {nodeWorkspaceContext} from '../src/node-workspace-context.mjs';
import {parseProjectWatchOptions,parseProjectWatchEvent,parseProjectSnapshot,parseProjectPatterns} from '../src/project-watch.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,{roots=[''],files={}}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-watch-'));
  for(const [name,content] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),content);}
  const workspace=await createNodeWorkspace({root});
  const port=await createNodeProjectWatcher({workspace,roots,fileSystem:'local'});
  t.after(async()=>{port.dispose();workspace.dispose();for(let n=0;n<100&&port.inspect().pendingScans;n++)await delay(10);assert.equal(port.inspect().pendingScans,0);assert.equal(port.inspect().nativeHandles,0);assert.ok(root.startsWith(path.join(os.tmpdir(),'dds-project-watch-')));await fs.rm(root,{recursive:true});});
  return{root,workspace,port};
}
async function event(iterator,accept=()=>true){
  let timer,last;
  try{return await Promise.race([(async()=>{for(;;){const next=await iterator.next();assert.equal(next.done,false);last={kind:next.value.kind,reason:next.value.reason,entries:next.value.snapshot.entries.length,reasons:next.value.snapshot.reasons};if(accept(next.value))return next.value;}})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('project observation timed out; last='+JSON.stringify(last))),35_000);})]);}
  finally{clearTimeout(timer);}
}

test('project contracts reject ambient roots, malformed patterns, forged entries and unsorted snapshots',()=>{
  assert.throws(()=>parseProjectWatchOptions({}),{code:'invalid_request'});
  for(const root of ['../outside','.env','.git/config','C:/root','a\\b'])assert.throws(()=>parseProjectWatchOptions({root}),{code:'unsafe_path'});
  for(const include of [['a/**b'],['../x'],['{a,b}'],Array(17).fill('*')])assert.throws(()=>parseProjectWatchOptions({root:'',include}),{code:'invalid_request'});
  assert.throws(()=>parseProjectWatchOptions({root:'',maxEntries:1001}),{code:'invalid_request'});
  const entry={path:'a',kind:'file',size:1,revision:hash('a'),fingerprint:hash('a')};
  assert.throws(()=>parseProjectSnapshot({version:1,root:'rtl',revision:hash(''),entries:[entry],complete:true,reasons:[],observedAt:1}),{code:'invalid_request'});
  assert.throws(()=>parseProjectSnapshot({version:1,root:'',revision:hash(''),entries:[entry,{...entry,path:'0'}],complete:true,reasons:[],observedAt:1}),{code:'invalid_request'});
  assert.throws(()=>parseProjectSnapshot({version:1,root:'',revision:hash(''),entries:[{...entry,revision:null}],complete:true,reasons:[],observedAt:1}),{code:'invalid_request'});
  let invoked=false;const patterns=[];Object.defineProperty(patterns,'0',{enumerable:true,get(){invoked=true;return '**';}});assert.throws(()=>parseProjectPatterns(patterns));assert.equal(invoked,false);
});

test('snapshot observes only operator roots, glob/exclusion policy, private paths and verified content',async t=>{
  const {root,port,workspace}=await fixture(t,{roots:['rtl'],files:{'rtl/top.sv':'module top; endmodule','rtl/nested/leaf.sv':'leaf','rtl/notes.txt':'note','rtl/cache/skip.sv':'skip','rtl/.env':'fixture-secret','outside.sv':'outside'}});
  assert.throws(()=>port.watch({root:''}),{code:'permission_denied'});
  const snapshot=await port.snapshot({root:'rtl',include:['**/*.sv'],exclude:['cache/**']});
  assert.deepEqual(snapshot.entries.map(x=>x.path),['rtl/nested/leaf.sv','rtl/top.sv']);
  assert.equal(snapshot.entries[1].revision,hash('module top; endmodule'));assert.equal(snapshot.complete,true);
  const again=await port.snapshot({root:'rtl',include:['**/*.sv'],exclude:['cache/**']});assert.equal(again.revision,snapshot.revision);
  await assert.rejects(createNodeProjectWatcher({workspace,roots:[''],fileSystem:'network'}),{code:'unsupported'});
  await assert.rejects(createNodeProjectWatcher({workspace:{},roots:[''],fileSystem:'local'}),{code:'invalid_request'});
  await fs.link(path.join(root,'outside.sv'),path.join(root,'rtl','linked.sv'));
  const linked=await port.snapshot({root:'rtl',include:['**/*.sv']});assert.equal(linked.entries.some(x=>x.path.endsWith('linked.sv')),false);assert.ok(linked.reasons.includes('unsafe_entries'));
});

test('atomic save, repeated writes, directory creation, file/directory moves and case-only names reconcile',async t=>{
  const {root,port}=await fixture(t,{files:{'rtl/top.sv':'zero'}});
  const iterator=port.watch({root:'rtl',intervalMs:250,debounceMs:20});t.after(()=>iterator.return());
  const initial=await event(iterator);assert.ok(['snapshot','resync'].includes(initial.kind));assert.equal(initial.snapshot.entries[0].revision,hash('zero'));
  await fs.writeFile(path.join(root,'rtl','.dds-write-fixture'),'one');await fs.rename(path.join(root,'rtl','.dds-write-fixture'),path.join(root,'rtl','top.sv'));
  const changed=await event(iterator,x=>x.snapshot.entries.some(e=>e.path==='rtl/top.sv'&&e.revision===hash('one')));assert.ok(changed.cursor>initial.cursor);if(changed.kind==='changes')assert.equal(changed.changes.find(x=>x.path==='rtl/top.sv')?.kind,'changed');else assert.equal(changed.kind,'resync');
  const forged={kind:'changed',path:'rtl/top.sv',previous:initial.snapshot.entries[0],current:{...changed.snapshot.entries[0],revision:hash('forged'),fingerprint:hash('forged')}};
  assert.throws(()=>parseProjectWatchEvent({...changed,kind:'changes',reason:null,previousRevision:initial.snapshot.revision,changes:[forged]}),{code:'invalid_request'});
  for(const value of ['two','three','four'])await fs.writeFile(path.join(root,'rtl','top.sv'),value);
  await event(iterator,x=>x.snapshot.entries.some(e=>e.revision===hash('four')));
  await fs.mkdir(path.join(root,'rtl','new'));await fs.writeFile(path.join(root,'rtl','new','child.sv'),'child');
  await event(iterator,x=>x.snapshot.entries.some(e=>e.path==='rtl/new/child.sv'));
  await fs.rename(path.join(root,'rtl','new'),path.join(root,'rtl','moved'));
  const moved=await event(iterator,x=>x.snapshot.entries.some(e=>e.path==='rtl/moved/child.sv')&&!x.snapshot.entries.some(e=>e.path.startsWith('rtl/new')));
  assert.equal(moved.changes.some(x=>x.kind==='moved'),false);
  await fs.rename(path.join(root,'rtl','top.sv'),path.join(root,'rtl','Top.sv'));
  await event(iterator,x=>x.snapshot.entries.some(e=>e.path==='rtl/Top.sv')&&!x.snapshot.entries.some(e=>e.path==='rtl/top.sv'));
  await fs.rm(path.join(root,'rtl','moved'),{recursive:true});await event(iterator,x=>!x.snapshot.entries.some(e=>e.path.startsWith('rtl/moved')));
  await iterator.return();assert.equal(port.inspect().observers,0);assert.equal(port.inspect().nativeHandles,0);
});

test('depth, entry, file/scan byte and snapshot budgets remain explicit',async t=>{
  const {port}=await fixture(t,{files:{'one.txt':'one','two.txt':'two','deep/a/b/file.txt':'deep'}});
  const shallow=await port.snapshot({root:'',maxDepth:1});assert.equal(shallow.complete,false);assert.ok(shallow.reasons.includes('depth_limit'));
  const limited=await port.snapshot({root:'',maxEntries:1});assert.equal(limited.entries.length,1);assert.ok(limited.reasons.includes('entry_limit'));
  const small=await port.snapshot({root:'',maxFileBytes:2});assert.ok(small.reasons.includes('file_bytes'));assert.equal(small.entries.filter(x=>x.kind==='file').every(x=>x.revision===null),true);
  const before=port.inspect().bytesRead;const budget=await port.snapshot({root:'',maxScanBytes:3});assert.ok(budget.reasons.includes('scan_bytes'));assert.ok(port.inspect().bytesRead-before<=3);
});

test('junction insertion never reads its target and root deletion releases all native resources',async t=>{
  const {root,port}=await fixture(t,{files:{'rtl/a.sv':'a','outside/secret.txt':'fixture-private'}});
  const iterator=port.watch({root:'rtl',intervalMs:250,debounceMs:20});t.after(()=>iterator.return());await event(iterator);
  await fs.symlink(path.join(root,'outside'),path.join(root,'rtl','escape'),process.platform==='win32'?'junction':'dir');
  const unsafe=await event(iterator,x=>x.snapshot.reasons.includes('unsafe_entries'));
  assert.equal(unsafe.snapshot.entries.some(x=>x.path.includes('secret')),false);assert.equal(unsafe.kind,'resync');
  await fs.unlink(path.join(root,'rtl','escape'));await event(iterator,x=>x.snapshot.complete);
  await fs.rm(path.join(root,'rtl'),{recursive:true});await assert.rejects(event(iterator),error=>['not_found','unsafe_path'].includes(error.code));
  assert.equal(port.inspect().nativeHandles,0);assert.equal(port.inspect().observers,0);
});

test('abort, permission revocation, workspace disposal and concurrent next discard later updates',async t=>{
  const {root,port,workspace}=await fixture(t,{files:{'a.txt':'a'}});
  const controller=new AbortController(),iterator=port.watch({root:'',intervalMs:250},{signal:controller.signal});await event(iterator);
  const pending=iterator.next();await assert.rejects(iterator.next(),{code:'conflict'});controller.abort();await assert.rejects(pending,{code:'cancelled'});assert.equal(port.inspect().nativeHandles,0);
  const revoked=port.watch({root:''});await event(revoked);const waiting=revoked.next();port.revoke();await assert.rejects(waiting,{code:'permission_denied'});await fs.writeFile(path.join(root,'a.txt'),'late');assert.equal((await revoked.next()).done,true);assert.equal(port.inspect().queuedEvents,0);
  const other=await createNodeProjectWatcher({workspace,roots:[''],fileSystem:'local'}),disposed=other.watch({root:''});await event(disposed);const result=disposed.next();workspace.dispose();await assert.rejects(result,{code:'disposed'});assert.equal(other.inspect().nativeHandles,0);
});

test('slow consumers receive a bounded resync snapshot after queue overflow',async t=>{
  const {root,port}=await fixture(t,{files:{'value.txt':'0'}}),iterator=port.watch({root:'',intervalMs:250,debounceMs:10});t.after(()=>iterator.return());await event(iterator);
  for(let i=1;i<=7;i++){
    const before=port.inspect().scans;await fs.writeFile(path.join(root,'value.txt'),String(i));
    for(let n=0;n<100&&port.inspect().scans===before;n++)await delay(10);
    await delay(30);
  }
  assert.ok(port.inspect().queuedEvents<=4);assert.ok(port.inspect().overflows>=1);
  const resync=await event(iterator,x=>x.reason==='consumer_overflow');assert.equal(resync.kind,'resync');assert.deepEqual(resync.changes,[]);assert.ok(resync.cursor>1);
  const hasLatest=x=>x.snapshot.entries.some(entry=>entry.path==='value.txt'&&entry.revision===hash('7'));
  const latest=hasLatest(resync)?resync:await event(iterator,hasLatest);
  assert.ok(hasLatest(parseProjectWatchEvent(latest)));
});

test('native hint loss, missing names, initial-scan races and native errors require explicit resync',async t=>{
  const {root,port}=await fixture(t,{files:{'a.txt':'before'}}),callbacks=[];let closed=0;
  t.mock.method(nativeFs,'watch',(_path,_options,callback)=>{
    const handle=new EventEmitter();handle.close=()=>{closed++;};callbacks.push({callback,handle});
    if(callbacks.length===1){nativeFs.writeFileSync(path.join(root,'a.txt'),'during-initial');callback('change','a.txt');}
    return handle;
  });
  syncBuiltinESMExports();
  t.after(()=>{port.dispose();t.mock.restoreAll();syncBuiltinESMExports();});
  const iterator=port.watch({root:'',intervalMs:60_000,debounceMs:10,scanTimeoutMs:30_000});
  const initial=await event(iterator);assert.equal(initial.kind,'resync');assert.equal(initial.reason,'initial_changed');assert.equal(initial.snapshot.entries[0].revision,hash('during-initial'));
  for(let n=0;n<2_048;n++)callbacks[0].callback('change','a.txt');
  const overflow=await event(iterator,x=>x.reason==='native_overflow');assert.equal(overflow.snapshot.revision,initial.snapshot.revision);assert.equal(port.inspect().queuedEvents,0);
  callbacks[0].callback('rename',null);assert.equal((await event(iterator)).reason,'native_unknown');
  for(let start=0;start<300;start+=20)await Promise.all(Array.from({length:20},(_,n)=>fs.writeFile(path.join(root,'batch-'+String(start+n).padStart(3,'0')+'.txt'),'batch')));
  callbacks[0].callback('rename','batch-000.txt');const bulk=await event(iterator,x=>x.reason==='change_limit');assert.equal(bulk.snapshot.entries.length,301);assert.equal(bulk.changes.length,0);
  callbacks[0].handle.emit('error',Object.assign(new Error('fixture-watch-error'),{code:'ENOSPC'}));assert.equal((await event(iterator)).reason,'native_unavailable');
  await iterator.return();assert.ok(closed>=2);assert.equal(port.inspect().nativeHandles,0);
});

test('revocation during an in-flight snapshot discards its result and drains file work',async t=>{
  const {port,workspace}=await fixture(t,{files:{'a.txt':'private fixture'}});
  const context=nodeWorkspaceContext(workspace),resolve=context.resolve;
  let release,entered;const gate=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});let blocked=false;
  context.resolve=async(...args)=>{if(args[0]==='a.txt'&&!blocked){blocked=true;entered();await gate;}return resolve(...args);};
  const request=port.snapshot({root:''});await started;port.revoke();release();await assert.rejects(request,{code:'permission_denied'});assert.equal(port.inspect().pendingScans,0);
});

test('observer/handle limits, mass changes and unavailable native APIs stay bounded',async t=>{
  const {root,port}=await fixture(t,{files:{'rtl/a.txt':'a'}});
  const iterators=Array.from({length:4},()=>port.watch({root:'rtl',intervalMs:60_000,debounceMs:10}));for(const iterator of iterators)await event(iterator);
  const excess=port.watch({root:'rtl'});await assert.rejects(excess.next(),{code:'budget_exceeded'});
  await Promise.all(iterators.map(iterator=>iterator.return()));
  for(let n=0;n<130;n++)await fs.mkdir(path.join(root,'rtl','dir'+String(n).padStart(3,'0')));
  const large=port.watch({root:'rtl',maxDepth:2,intervalMs:60_000,debounceMs:10,scanTimeoutMs:30_000});
  const first=await event(large);assert.equal(first.reason,'watcher_limit');assert.equal(port.inspect().nativeHandles,128);
  await large.return();assert.equal(port.inspect().nativeHandles,0);
  t.mock.method(nativeFs,'watch',()=>{throw Object.assign(new Error('fixture unsupported native watcher'),{code:'ENOSYS'});});syncBuiltinESMExports();
  t.after(()=>{port.dispose();t.mock.restoreAll();syncBuiltinESMExports();});
  const fallback=port.watch({root:'rtl',maxDepth:1,intervalMs:250,debounceMs:10,scanTimeoutMs:30_000});assert.equal((await event(fallback)).reason,'native_unavailable');
  await fs.writeFile(path.join(root,'rtl','a.txt'),'periodic');await event(fallback,x=>x.snapshot.entries.some(x=>x.revision===hash('periodic')));await fallback.return();
});
