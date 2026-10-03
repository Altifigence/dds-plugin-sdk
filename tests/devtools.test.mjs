import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {initPlugin,doctorPlugin,runPluginDev} from '../src/devtools.mjs';
import {validatePluginPackage} from '../src/publishing.mjs';
import {deferred} from './fixtures.mjs';

const sdkRoot=fileURLToPath(new URL('../',import.meta.url)),cli=fileURLToPath(new URL('../bin/dds-plugin.mjs',import.meta.url));
async function fixture(t,{installed=true}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-devtools-'))),directory=path.join(root,'my-plugin');
  await initPlugin(directory,{publisher:'author',id:'sample-plugin'});
  let linked;
  if(installed){const parent=path.join(directory,'node_modules','@altifigence');await fs.mkdir(parent,{recursive:true});linked=path.join(parent,'dds-plugin-sdk');await fs.symlink(sdkRoot,linked,process.platform==='win32'?'junction':'dir');}
  t.after(async()=>{if(linked)await fs.unlink(linked);assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));await fs.rm(root,{recursive:true});});
  return{root,directory};
}
async function gone(pid) {for(let i=0;i<100;i++){try{process.kill(pid,0);}catch(failure){if(failure.code==='ESRCH')return;throw failure;}await delay(20);}throw Error('Dev child survived cleanup');}
test('init creates a valid standalone scaffold and never replaces existing content',async t=>{
  const {directory}=await fixture(t,{installed:false});const before=await fs.readFile(path.join(directory,'plugin.mjs'),'utf8');
  assert.equal((await validatePluginPackage(directory)).pluginId,'sample-plugin');
  await assert.rejects(initPlugin(directory),/already exists/);assert.equal(await fs.readFile(path.join(directory,'plugin.mjs'),'utf8'),before);
  const metadata=JSON.parse(await fs.readFile(path.join(directory,'package.json'),'utf8'));assert.equal(metadata.private,true);assert.match(metadata.dependencies['@altifigence/dds-plugin-sdk'],/\/v0\.5\.0\//);
  const report=await doctorPlugin(directory);assert.equal(report.ok,false);assert.equal(report.checks.find(c=>c.id==='sdk').status,'error');
});
test('doctor never imports plugin code and returns actionable human and JSON diagnostics',async t=>{
  const {directory}=await fixture(t);const marker=path.join(directory,'executed.txt');
  await fs.writeFile(path.join(directory,'plugin.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');throw Error('must not run');\n`);
  const report=await doctorPlugin(directory);assert.equal(report.ok,true);assert.equal(report.checks.find(c=>c.id==='publisher').status,'warning');
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  for(const args of [[],['--json']]){const result=spawnSync(process.execPath,[cli,'doctor',directory,...args],{encoding:'utf8',timeout:10_000});assert.equal(result.status,0,result.stderr);if(args.length)assert.equal(JSON.parse(result.stdout).ok,true);else assert.match(result.stdout,/PASS package/);}
  await fs.writeFile(path.join(directory,'plugin.json'),'{}');const result=spawnSync(process.execPath,[cli,'doctor',directory,'--json'],{encoding:'utf8',timeout:10_000});assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).ok,false);await assert.rejects(fs.stat(marker),{code:'ENOENT'});
});
test('dev requires explicit trust and executes a scaffold command and job in cleaned child processes',async t=>{
  const {directory}=await fixture(t);await assert.rejects(runPluginDev(directory,{}),/trust-local-code/);
  for(const job of [false,true]) {
    const events=[];const result=await runPluginDev(directory,{trustLocalCode:true,command:'greet',input:{name:'DDS'},job,onEvent:event=>events.push(event)});
    assert.equal(result.ok,true);assert.equal(result.runs,1);assert.match(events.filter(e=>e.type==='output').map(e=>e.text).join(''),/Hello, DDS!/);
    const pid=events.find(e=>e.type==='start').pid;assert.notEqual(pid,process.pid);await gone(pid);
    if(job)assert.match(events.filter(e=>e.type==='output').map(e=>e.text).join(''),/job-event/);
  }
});
test('watch restarts allowlisted files, skips undeclared files and stops all owned children',async t=>{
  const {directory}=await fixture(t);const controller=new AbortController(),events=[],first=deferred(),second=deferred();
  const running=runPluginDev(directory,{trustLocalCode:true,watch:true,signal:controller.signal,onEvent:event=>{events.push(event);if(event.type==='complete'&&event.run===1)first.resolve();if(event.type==='complete'&&event.run===2)second.resolve();}});
  t.after(()=>controller.abort());await first.promise;
  await fs.writeFile(path.join(directory,'not-watched.txt'),'unrelated');await delay(650);assert.equal(events.filter(e=>e.type==='start').length,1);
  await fs.appendFile(path.join(directory,'plugin.mjs'),'\n// Changed by watch test.\n');await Promise.race([second.promise,delay(5_000).then(()=>{throw Error('Watch did not restart');})]);
  controller.abort();const result=await running;assert.equal(result.stopped,true);assert.equal(result.runs,2);
  for(const event of events.filter(e=>e.type==='start'))await gone(event.pid);
});
test('dev handles invalid input, worker failure, import timeout and output limits without hanging',async t=>{
  const {directory}=await fixture(t);
  await assert.rejects(runPluginDev(directory,{trustLocalCode:true,job:true}),/requires --command/);
  await assert.rejects(runPluginDev(directory,{trustLocalCode:true,timeoutMs:0}),/timeout/);
  const missing=await runPluginDev(directory,{trustLocalCode:true,command:'missing'});assert.equal(missing.ok,false);
  await fs.writeFile(path.join(directory,'plugin.mjs'),'await new Promise(()=>{});\n');const timed=await runPluginDev(directory,{trustLocalCode:true,timeoutMs:20});assert.equal(timed.ok,false);
  await fs.writeFile(path.join(directory,'plugin.mjs'),"process.stdout.write('x'.repeat(300_000));await new Promise(()=>{});\n");await assert.rejects(runPluginDev(directory,{trustLocalCode:true}),/output exceeded/);
});
test('CLI rejects unknown or duplicate flags and does not start an untrusted dev command',async t=>{
  const {directory}=await fixture(t);
  for(const args of [['dev',directory],['doctor',directory,'--json','--json'],['init',path.join(directory,'new'),'--unknown'],['dev',directory,'--trust-local-code','--input','not-json']]){
    const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8',timeout:10_000});assert.equal(result.status,1);assert.equal(result.stdout,'');
  }
});
test('dev cleans up a plugin-owned descendant on normal completion and abort during execution',async t=>{
  for(const mode of ['complete','abort']) {
    const {directory}=await fixture(t),controller=new AbortController();let descendant;
    await fs.writeFile(path.join(directory,'plugin.mjs'), `import {spawn} from 'node:child_process';\nimport {definePlugin} from '@altifigence/dds-plugin-sdk';\nimport manifest from './plugin.json' with {type:'json'};\nexport default definePlugin(manifest, context => {const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});process.stdout.write(JSON.stringify({descendant:child.pid})+'\\n');${mode==='abort'?'return new Promise(()=>{});':'return context.registerCommand({id:"greet",title:"Greet"},()=>null);'}});\n`);
    const execution=runPluginDev(directory,{trustLocalCode:true,signal:controller.signal,onEvent(event){if(event.type==='output'){const match=/"descendant":(\d+)/.exec(event.text);if(match){descendant=Number(match[1]);if(mode==='abort')controller.abort();}}}});
    t.after(()=>controller.abort());await execution;assert.ok(descendant>0);await gone(descendant);
  }
});
