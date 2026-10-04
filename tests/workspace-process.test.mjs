import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createProcessBackend} from '../src/workspace-node.mjs';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-workspace-process-'));t.after(async()=>{assert.ok(root.startsWith(path.join(os.tmpdir(),'dds-workspace-process-')));await fs.rm(root,{recursive:true,maxRetries:10,retryDelay:100});});return root;}
test('fixed process adapter bounds JSON, excludes inherited secrets, hides stderr and freezes args',async t=>{
  const root=await fixture(t);const previous=process.env.DDS_TEST_PRIVATE_SECRET;process.env.DDS_TEST_PRIVATE_SECRET='fixture-secret';t.after(()=>{if(previous===undefined)delete process.env.DDS_TEST_PRIVATE_SECRET;else process.env.DDS_TEST_PRIVATE_SECRET=previous;});
  const args=['-e',"process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({secretInherited:Object.hasOwn(process.env,'DDS_TEST_PRIVATE_SECRET')})))"];
  const backend=createProcessBackend({executable:process.execPath,args,cwd:root});args[1]='throw new Error("changed")';assert.deepEqual(await backend({}),{secretInherited:false});
  const loud=createProcessBackend({executable:process.execPath,args:['-e',"process.stdout.write('x'.repeat(300000));setInterval(()=>{},1000)"],cwd:root});await assert.rejects(loud({}),{code:'budget_exceeded'});
  const failed=createProcessBackend({executable:process.execPath,args:['-e',"console.error('fixture-secret');process.exit(1)"],cwd:root});await assert.rejects(failed({}),failure=>failure.code==='provider_failed'&&!failure.message.includes('fixture-secret'));
  const malformed=createProcessBackend({executable:process.execPath,args:['-e',"process.stdout.write('not JSON')"],cwd:root});await assert.rejects(malformed({}),{code:'provider_failed'});
});
test('cancellation stops the running owned parent and child tree on this platform',async t=>{
  const root=await fixture(t),marker=path.join(root,'owned-pids.json');
  const script=`const fs=require('node:fs');const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  const backend=createProcessBackend({executable:process.execPath,args:['-e',script],cwd:root,timeoutMs:5_000});const controller=new AbortController();const work=backend({},{signal:controller.signal});
  let pids;for(let i=0;i<100;i++){try{pids=JSON.parse(await fs.readFile(marker,'utf8'));break;}catch{await pause(20);}}
  assert.ok(pids,'Owned process did not start');controller.abort();await assert.rejects(work,{code:'cancelled'});
  for(const pid of pids){let running=true;for(let i=0;i<75;i++){try{process.kill(pid,0);}catch(failure){assert.equal(failure.code,'ESRCH');running=false;break;}await pause(20);}assert.equal(running,false,`Owned process ${pid} still running`);}
});
test('process deadline stops a fixed owned process',async t=>{
  const root=await fixture(t);const backend=createProcessBackend({executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:root,timeoutMs:100});await assert.rejects(backend({}),{code:'budget_exceeded'});
});
