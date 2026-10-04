import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createNodeWorkspace} from '../src/workspace-node.mjs';
import {createNodeProjectWatcher} from '../src/project-watch-node.mjs';
import {createNodeProjectQueries} from '../src/project-query-node.mjs';
import {parseProjectQueryOptions,parseProjectQueryPage,parseProjectQueryCapabilities} from '../src/project-query.mjs';
import {nodeWorkspaceContext} from '../src/node-workspace-context.mjs';
import {nodeProjectContext} from '../src/node-project-context.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t,files,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-project-query-'));
  for(const [name,content] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),content);}
  const workspace=await createNodeWorkspace({root}),watcher=await createNodeProjectWatcher({workspace,roots:options.roots??[''],fileSystem:'local'}),queries=createNodeProjectQueries({watcher,...(options.cursorTtlMs?{cursorTtlMs:options.cursorTtlMs}:{})});
  t.after(async()=>{queries.dispose();watcher.dispose();workspace.dispose();assert.equal(queries.inspect().activeQueries,0);assert.equal(queries.inspect().views,0);assert.equal(watcher.inspect().pendingScans,0);assert.equal(watcher.inspect().nativeHandles,0);assert.equal(path.dirname(await fs.realpath(root)),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-project-query-'));await fs.rm(root,{recursive:true});});
  return{root,workspace,watcher,queries};
}

test('query options require explicit roots, bounded literal/glob syntax and valid budgets',()=>{
  for(const value of [{kind:'tree'},{kind:'tree',root:'../x'},{kind:'tree',root:'.env'},{kind:'tree',root:'',query:'x'},{kind:'text',root:'',query:''},{kind:'text',root:'',query:'x',mode:'glob'},{kind:'text',root:'',query:'x',maxFileBytes:262145},{kind:'files',root:'',query:'a/**b',mode:'glob'},{kind:'files',root:'',query:'\uD800'},{kind:'text',root:'',query:'\n'},{kind:'tree',root:'',pageSize:65},{kind:'tree',root:'',cursor:'bad'},{kind:'tree',root:'',maxResponseBytes:100}])assert.throws(()=>parseProjectQueryOptions(value));
  let invoked=false;const value={kind:'tree'};Object.defineProperty(value,'root',{enumerable:true,get(){invoked=true;return '';}});assert.throws(()=>parseProjectQueryOptions(value));assert.equal(invoked,false);
  assert.throws(()=>createNodeProjectQueries({watcher:{}}),{code:'invalid_request'});
});

test('tree and filename queries intersect roots, patterns, protected paths and link policy',async t=>{
  const f=await fixture(t,{'rtl/top.SV':'top','rtl/sub/leaf.sv':'leaf','rtl/sub/readme.txt':'note','rtl/cache/no.sv':'cache','rtl/.env':'private','rtl/.notes':'hidden allowed','elsewhere.txt':'outside'},{roots:['rtl']});
  await assert.rejects(f.queries.listTree({root:''}),{code:'permission_denied'});
  await assert.rejects(f.queries.listTree({root:'rtl',kind:'text'}),{code:'invalid_request'});
  const options={root:'rtl',query:'**/*.sv',mode:'glob',caseSensitive:false,exclude:['cache/**']};
  assert.deepEqual(parseProjectQueryCapabilities(f.queries.capabilities).roots,['rtl']);
  assert.throws(()=>parseProjectQueryCapabilities({...f.queries.capabilities,caseFolding:'unicode'}),{code:'invalid_request'});
  const found=await f.queries.searchFiles(options);assert.equal(found.complete,true);assert.deepEqual(found.items.map(x=>x.entry.path),['rtl/sub/leaf.sv','rtl/top.SV']);assert.ok(found.items.every(x=>x.state==='current'&&x.entry.revision===x.currentRevision));
  assert.equal((await f.queries.searchFiles({...options,caseSensitive:true})).total,1);
  assert.equal((await f.queries.searchFiles({root:'rtl',query:'sub/leaf'})).total,1);
  const tree=await f.queries.listTree({root:'rtl'});assert.ok(tree.items.some(x=>x.entry.kind==='directory'));assert.ok(!tree.items.some(x=>x.entry.path.includes('.env')));
  await fs.link(path.join(f.root,'elsewhere.txt'),path.join(f.root,'rtl','linked.txt'));
  await fs.mkdir(path.join(f.root,'external'));await fs.writeFile(path.join(f.root,'external','hidden.txt'),'needle');await fs.symlink(path.join(f.root,'external'),path.join(f.root,'rtl','escape'),process.platform==='win32'?'junction':'dir');
  const guarded=await f.queries.searchText({root:'rtl',query:'needle'});assert.equal(guarded.total,0);assert.ok(guarded.reasons.includes('unsafe_entries'));
});

test('text search returns content SHA, UTF-16 ranges and bounded Unicode-safe snippets',async t=>{
  const content='\uFEFF😃 CLOCK clock\r\n한글 İ CLOCK\rfinal CLOCK\n'+('😃'.repeat(100))+'CLOCK'+'z'.repeat(800);
  const {queries}=await fixture(t,{'a.txt':content});
  const page=await queries.searchText({root:'',query:'clock',caseSensitive:false});assert.equal(page.complete,true);assert.equal(page.total,5);
  assert.deepEqual(page.items.slice(0,4).map(x=>x.match.range.start),[{line:0,character:3},{line:0,character:9},{line:1,character:5},{line:2,character:6}]);
  for(const item of page.items){assert.equal(item.entry.revision,sha(content));assert.equal(item.match.range.end.character-item.match.range.start.character,5);assert.ok(item.match.snippet.text.isWellFormed());assert.ok(item.match.snippet.text.length<=512);}
  assert.equal(page.items[4].match.snippet.leading,true);assert.equal(page.items[4].match.snippet.trailing,true);
  assert.equal((await queries.searchText({root:'',query:'i',caseSensitive:false})).items.some(x=>x.match.range.start.line===1),false);
  assert.equal((await queries.searchText({root:'',query:'CLOCK'})).total,4);
});

test('pagination freezes membership and revisions while marking modifications, deletions and moves',async t=>{
  const f=await fixture(t,{'a.txt':'find a','b.txt':'find b','c.txt':'find c','d.txt':'find d'});
  const options={root:'',query:'find',pageSize:1};const first=await f.queries.searchText(options);assert.equal(first.total,4);assert.equal(first.stale,false);
  await fs.writeFile(path.join(f.root,'b.txt'),'new b');await fs.rm(path.join(f.root,'c.txt'));await fs.rename(path.join(f.root,'d.txt'),path.join(f.root,'moved.txt'));await fs.writeFile(path.join(f.root,'aa.txt'),'find new');
  const second=await f.queries.searchText({...options,cursor:first.nextCursor});assert.equal(second.total,4);assert.equal(second.stale,true);assert.equal(second.items[0].entry.path,'b.txt');assert.equal(second.items[0].entry.revision,sha('find b'));assert.equal(second.items[0].currentRevision,sha('new b'));assert.equal(second.items[0].state,'changed');
  const third=await f.queries.searchText({...options,cursor:second.nextCursor});assert.equal(third.items[0].state,'missing');
  const fourth=await f.queries.searchText({...options,cursor:third.nextCursor});assert.equal(fourth.items[0].state,'missing');assert.equal(fourth.nextCursor,null);
  const repeated=await f.queries.searchText({...options,cursor:first.nextCursor});assert.deepEqual(repeated.items,second.items);
  await assert.rejects(f.queries.searchText({...options,query:'new',cursor:first.nextCursor}),{code:'invalid_request'});
  await assert.rejects(f.queries.searchText({...options,cursor:first.viewId+':99'}),{code:'invalid_request'});
  assert.equal(f.queries.releaseCursor(first.nextCursor),true);assert.equal(f.queries.releaseCursor(first.nextCursor),false);await assert.rejects(f.queries.searchText({...options,cursor:first.nextCursor}),{code:'not_found'});
});

test('binary, invalid UTF-8, file/scan/depth/results and response budgets remain explicit',async t=>{
  const f=await fixture(t,{'a.txt':'hit '.repeat(500),'b.bin':Buffer.from([0,104,105,116]),'c.bin':Buffer.from([0xff,104,105,116]),'deep/nested/a.txt':'hit','large.txt':'x'.repeat(262145)});
  const query={root:'',query:'hit',maxResults:3};const page=await f.queries.searchText(query);assert.equal(page.total,3);assert.equal(page.complete,false);assert.equal(page.truncated,true);for(const reason of ['result_limit','binary','invalid_utf8','file_bytes'])assert.ok(page.reasons.includes(reason),reason);
  const before=f.watcher.inspect().bytesRead;const bounded=await f.queries.searchText({root:'',query:'hit',maxScanBytes:6});assert.ok(bounded.reasons.includes('scan_bytes'));assert.ok(f.watcher.inspect().bytesRead-before<=6);
  const depth=await f.queries.listTree({root:'',maxDepth:1});assert.ok(depth.reasons.includes('depth_limit'));
  const entries=await f.queries.listTree({root:'',maxEntries:1});assert.ok(entries.reasons.includes('entry_limit'));
  const timeout=await f.queries.listTree({root:'',scanTimeoutMs:1});assert.ok(timeout.reasons.includes('scan_timeout'));
  const expanded=await f.queries.searchText({root:'',include:['a.txt'],query:'hit',maxResults:512,pageSize:64,maxResponseBytes:16384});assert.ok(Buffer.byteLength(JSON.stringify(expanded))<=16384);assert.ok(expanded.items.length<64);assert.ok(expanded.nextCursor);f.queries.releaseCursor(expanded.nextCursor);
});

test('text hashing and search share one bounded read, and unstable files never gain valid ranges',async t=>{
  const f=await fixture(t,{'a.txt':'search source'});const start=f.watcher.inspect().bytesRead;
  const page=await f.queries.searchText({root:'',query:'search'});assert.equal(page.total,1);assert.equal(f.watcher.inspect().bytesRead-start,13);
  const context=nodeWorkspaceContext(f.workspace),resolve=context.resolve;let count=0;
  context.resolve=async(...args)=>{if(args[0]==='a.txt'&&++count===3)await fs.writeFile(path.join(f.root,'a.txt'),'changed source');return resolve(...args);};
  const raced=await f.queries.searchText({root:'',query:'search'});context.resolve=resolve;assert.equal(raced.total,0);assert.ok(raced.reasons.includes('unstable'));
});

test('cursor capacity, explicit release, expiration and independent port generations',async t=>{
  const f=await fixture(t,{'a':'x','b':'x'}),options={root:'',pageSize:1},cursors=[];
  for(let i=0;i<8;i++)cursors.push((await f.queries.listTree(options)).nextCursor);
  assert.equal(f.queries.inspect().views,8);await assert.rejects(f.queries.listTree(options),{code:'budget_exceeded'});
  f.queries.releaseCursor(cursors[0]);const page=await f.queries.listTree(options);assert.ok(page.nextCursor);
  const other=createNodeProjectQueries({watcher:f.watcher,cursorTtlMs:20});t.after(()=>other.dispose());await assert.rejects(other.listTree({...options,cursor:page.nextCursor}),{code:'not_found'});
  const short=await other.listTree(options);await delay(25);await assert.rejects(other.listTree({...options,cursor:short.nextCursor}),{code:'not_found'});assert.equal(other.inspect().views,0);
});

test('concurrency, cancel, query revoke and watcher disposal discard pending scans and release views',async t=>{
  const f=await fixture(t,{'a':'x','b':'x'}),context=nodeProjectContext(f.watcher),scan=context.scan;
  let release;const gate=new Promise(resolve=>{release=resolve;});context.scan=async(...args)=>{await gate;return scan(...args);};
  const controller=new AbortController(),one=f.queries.listTree({root:''},{signal:controller.signal}),two=f.queries.searchText({root:'',query:'x'});
  await assert.rejects(f.queries.listTree({root:''}),{code:'budget_exceeded'});controller.abort();const rejected=assert.rejects(one,{code:'cancelled'});release();await rejected;await two;context.scan=scan;
  await f.queries.listTree({root:'',pageSize:1});assert.equal(f.queries.inspect().views,1);
  let unlock;const stopped=new Promise(resolve=>{unlock=resolve;});context.scan=async(...args)=>{await stopped;return scan(...args);};
  const pending=f.queries.listTree({root:''});const revoked=assert.rejects(pending,{code:'permission_denied'});f.queries.revoke();unlock();await revoked;context.scan=scan;assert.equal(f.queries.inspect().views,0);
  const queries=createNodeProjectQueries({watcher:f.watcher});t.after(()=>queries.dispose());await queries.listTree({root:'',pageSize:1});f.watcher.dispose();await assert.rejects(queries.listTree({root:''}),{code:'disposed'});assert.equal(queries.inspect().views,0);
});

test('query pages reject forged paths, snippets, ranges, states and cursors',async t=>{
  const {queries}=await fixture(t,{'a':'match','b':'match'});const page=await queries.searchText({root:'',query:'match',pageSize:1});
  for(const mutate of [x=>{x.nextCursor=x.viewId+':2';},x=>{x.items[0].entry.path='../secret';},x=>{x.items[0].match.range.end.character=99;},x=>{x.items[0].match.range.end.line=1;},x=>{x.items[0].currentRevision='f'.repeat(64);},x=>{x.complete=false;},x=>{x.kind='tree';},x=>{x.items[0].state='missing';x.items[0].currentRevision=null;}]){const copy=structuredClone(page);mutate(copy);assert.throws(()=>parseProjectQueryPage(copy));}
});

test('retained result bytes and admission-time deadlines bound dense Unicode searches',async t=>{
  const f=await fixture(t,{'a.txt':('hit'+'😃'.repeat(200)).repeat(320)});
  const dense=await f.queries.searchText({root:'',query:'hit',maxResults:512});assert.ok(dense.reasons.includes('result_bytes'));assert.ok(dense.total<320);assert.ok(f.queries.inspect().retainedBytes<=262144);f.queries.releaseCursor(dense.nextCursor);
  const context=nodeProjectContext(f.watcher),scan=context.scan;context.scan=async(...args)=>{await delay(20);return scan(...args);};
  const timed=await f.queries.listTree({root:'',scanTimeoutMs:5});context.scan=scan;assert.ok(timed.reasons.includes('scan_timeout'));assert.equal(timed.total,0);
});

test('partial page revalidation marks unverifiable entries without claiming deletion',async t=>{
  const f=await fixture(t,{'a':'x','b':'x'}),options={root:'',pageSize:1,maxScanBytes:2};
  const first=await f.queries.listTree(options);await fs.writeFile(path.join(f.root,'b'),'x'.repeat(20));
  const second=await f.queries.listTree({...options,cursor:first.nextCursor});assert.equal(second.items[0].state,'unverified');assert.equal(second.items[0].currentRevision,null);assert.equal(second.stale,true);assert.equal(second.complete,true);
  f.queries.releaseCursor(first.nextCursor);
});
