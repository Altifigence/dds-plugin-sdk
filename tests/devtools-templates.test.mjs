import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {initPlugin,planPlugin,generatePluginContracts,doctorPlugin,PLUGIN_TEMPLATES} from '../src/devtools.mjs';
import {validatePluginPackage,packPlugin,verifyPluginArchive} from '../src/publishing.mjs';
import {writeNewDirectory} from '../src/dev-files.mjs';

const sdk=fileURLToPath(new URL('../',import.meta.url)),cli=path.join(sdk,'bin/dds-plugin.mjs');
const run=(args,cwd)=>{const r=spawnSync(process.execPath,args,{cwd,encoding:'utf8',timeout:30_000,windowsHide:true});assert.equal(r.status,0,r.error?.message??r.stderr??r.stdout);return r.stdout;};
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'dds-templates-'))),links=[];
  t.after(async()=>{for(const link of links)await fs.unlink(link);assert.equal(path.dirname(root),await fs.realpath(os.tmpdir()));assert.ok(path.basename(root).startsWith('dds-templates-'));await fs.rm(root,{recursive:true,maxRetries:10,retryDelay:100});});
  return {root,async install(directory){const parent=path.join(directory,'node_modules/@altifigence');await fs.mkdir(parent,{recursive:true});const link=path.join(parent,'dds-plugin-sdk');await fs.symlink(sdk,link,process.platform==='win32'?'junction':'dir');links.push(link);}};
}
test('all templates run, typecheck and produce independently verifiable plugin archives',async t=>{
  const f=await fixture(t);
  for(const template of PLUGIN_TEMPLATES){
    const directory=path.join(f.root,template),plan=await planPlugin(directory,{template,id:'example-'+template});
    assert.equal(plan.writes,false);assert.equal(plan.conflicts.length,0);await assert.rejects(fs.stat(directory),{code:'ENOENT'});
    const generated=await initPlugin(directory,{template,id:'example-'+template});assert.deepEqual(generated.files,plan.files.map(file=>file.path));await f.install(directory);
    const doctor=await doctorPlugin(directory);assert.equal(doctor.ok,true,JSON.stringify(doctor.checks));assert.equal((await generatePluginContracts(directory,{check:true})).ok,true);
    run(['--test','plugin.test.mjs'],directory);run([path.join(sdk,'node_modules/typescript/bin/tsc'),'--project','tsconfig.json'],directory);
    assert.equal(JSON.parse(run(['run.mjs'],directory)).verified,true);
    const packed=await packPlugin(directory,{out:path.join(f.root,template+'-dist')});assert.equal((await verifyPluginArchive(packed.archivePath,{expectedSha256:packed.artifact.sha256})).checksumPinned,true);
  }
});
test('dry-run reports an existing destination and never writes or installs',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'my plugin');await fs.mkdir(directory);await fs.writeFile(path.join(directory,'retained.txt'),'preserve');
  const report=await initPlugin(directory,{id:'my-plugin',dryRun:true});assert.deepEqual(report.conflicts,[{path:'.',reason:'destination_exists'}]);
  await assert.rejects(initPlugin(directory,{id:'my-plugin'}),{code:'conflict'});assert.deepEqual(await fs.readdir(directory),['retained.txt']);
  for(const options of [{template:'unknown'},{id:'../invalid'},{license:'MIT'},{license:'LicenseRef-Proprietary'},{dryRun:'yes'}])await assert.rejects(initPlugin(path.join(f.root,'reject'),options));
  await assert.rejects(initPlugin(path.join(f.root,'CON')),{code:'invalid_path'});
});
test('generation is deterministic, requires exact replacement and preserves all manual edits',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'configuration');await initPlugin(directory,{template:'configuration'});
  const before=await generatePluginContracts(directory,{check:true}),noOp=await generatePluginContracts(directory);assert.equal(noOp.written,false);
  const definitionPath=path.join(directory,'dds-dev.json'),definition=JSON.parse(await fs.readFile(definitionPath,'utf8'));
  definition.commands[0].title='New title';await fs.writeFile(definitionPath,JSON.stringify(definition));
  assert.equal((await generatePluginContracts(directory,{check:true})).ok,false);
  const preview=await generatePluginContracts(directory,{dryRun:true});assert.equal(preview.previousDigest,before.digest);assert.notEqual(preview.digest,before.digest);
  await assert.rejects(generatePluginContracts(directory),{code:'conflict'});await assert.rejects(generatePluginContracts(directory,{expectedDigest:'a'.repeat(64)}),{code:'conflict'});
  await fs.writeFile(path.join(directory,'unrelated.txt'),'preserve');const after=await generatePluginContracts(directory,{expectedDigest:before.digest});assert.equal(after.written,true);assert.equal(after.digest,preview.digest);assert.equal((await generatePluginContracts(directory,{check:true})).ok,true);assert.equal(await fs.readFile(path.join(directory,'unrelated.txt'),'utf8'),'preserve');
  const edited=path.join(directory,'generated/contracts.d.mts');await fs.appendFile(edited,'// manual edit\n');assert.equal((await generatePluginContracts(directory,{check:true})).ok,false);
  await assert.rejects(generatePluginContracts(directory,{expectedDigest:after.digest}),{code:'conflict'});assert.match(await fs.readFile(edited,'utf8'),/manual edit/);
  assert.ok(!(await fs.readdir(directory)).some(name=>name.startsWith('.dds-generation')||name==='.dds-generate.lock'));
});
test('generation rejects linked destinations, extras, stale locks and malformed source without executing it',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'command');await initPlugin(directory);const before=await generatePluginContracts(directory,{check:true});
  await fs.writeFile(path.join(directory,'generated/unrelated.txt'),'preserve');await assert.rejects(generatePluginContracts(directory,{expectedDigest:before.digest}),{code:'conflict'});await fs.unlink(path.join(directory,'generated/unrelated.txt'));
  const source=JSON.parse(await fs.readFile(path.join(directory,'dds-dev.json'),'utf8'));source.commands[0].title='Changed';await fs.writeFile(path.join(directory,'dds-dev.json'),JSON.stringify(source));
  await fs.writeFile(path.join(directory,'.dds-generate.lock'),'previous operation');await assert.rejects(generatePluginContracts(directory,{expectedDigest:before.digest}),{code:'conflict'});assert.equal(await fs.readFile(path.join(directory,'.dds-generate.lock'),'utf8'),'previous operation');await fs.unlink(path.join(directory,'.dds-generate.lock'));
  source.run='throw new Error()';await fs.writeFile(path.join(directory,'dds-dev.json'),JSON.stringify(source));await assert.rejects(generatePluginContracts(directory,{dryRun:true}),{code:'invalid_contract'});
  const linked=path.join(f.root,'linked');await fs.symlink(directory,linked,process.platform==='win32'?'junction':'dir');try{await assert.rejects(generatePluginContracts(linked,{check:true}),{code:'unsafe_path'});}finally{await fs.unlink(linked);}
});
test('injected partial write failures remove only owned entries and preserve additional files',async t=>{
  const f=await fixture(t),files=new Map([['a.mjs','one'],['nested/b.mjs','two']]);
  for(const preserve of [false,true]){
    const destination=path.join(f.root,preserve?'preserve':'rollback');let calls=0;
    await assert.rejects(writeNewDirectory(destination,files,{async write(handle,text){await handle.writeFile(text);if(++calls===2){if(preserve)await fs.writeFile(path.join(destination,'unrelated.txt'),'preserve');const error=new Error('Synthetic disk full');error.code='ENOSPC';throw error;}}}),error=>error.code==='write_failed'&&error.cleanupPreserved===preserve);
    if(preserve){assert.deepEqual(await fs.readdir(destination),['unrelated.txt']);assert.equal(await fs.readFile(path.join(destination,'unrelated.txt'),'utf8'),'preserve');}else await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  }
});
test('failed generation preserves edits to an already-created owned file',async t=>{
  const f=await fixture(t),destination=path.join(f.root,'edited');let calls=0;
  await assert.rejects(writeNewDirectory(destination,new Map([['a.txt','original'],['b.txt','second']]),{async write(handle,text){
    await handle.writeFile(text);if(++calls===2){await fs.writeFile(path.join(destination,'a.txt'),'user edit');throw Object.assign(new Error('Synthetic write failure'),{code:'ENOSPC'});}
  }}),error=>error.code==='write_failed'&&error.cleanupPreserved===true);
  assert.deepEqual(await fs.readdir(destination),['a.txt']);assert.equal(await fs.readFile(path.join(destination,'a.txt'),'utf8'),'user edit');
});

test('caller-selected proprietary terms keep inherited license and notice bytes',async t=>{
  const f=await fixture(t),license=path.join(f.root,'terms.txt'),directory=path.join(f.root,'private-plugin');await fs.writeFile(license,'Synthetic proprietary fixture. No distribution rights are granted.\n');
  await initPlugin(directory,{license:'LicenseRef-Proprietary',licenseFile:license});assert.equal((await validatePluginPackage(directory)).pluginId,'private-plugin');
  const manifest=JSON.parse(await fs.readFile(path.join(directory,'plugin.json'),'utf8'));assert.equal(manifest.source.visibility,'closed');assert.equal(manifest.license,'LicenseRef-Proprietary');assert.equal(await fs.readFile(path.join(directory,'LICENSE'),'utf8'),await fs.readFile(license,'utf8'));assert.equal(await fs.readFile(path.join(directory,'LICENSE.sdk'),'utf8'),await fs.readFile(path.join(sdk,'LICENSE'),'utf8'));
});
test('CLI generation exposes preview/check and source drift as a nonzero status',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'cli');assert.equal(JSON.parse(run([cli,'init',directory,'--dry-run'],f.root)).writes,false);await assert.rejects(fs.stat(directory),{code:'ENOENT'});
  run([cli,'init',directory,'--template','configuration'],f.root);assert.equal(JSON.parse(run([cli,'generate',directory,'--check'],f.root)).ok,true);
  await fs.appendFile(path.join(directory,'generated/contracts.mjs'),'// changed\n');const r=spawnSync(process.execPath,[cli,'generate',directory,'--check'],{encoding:'utf8',windowsHide:true,timeout:10_000});assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).ok,false);
});

test('doctor reports newly generated schemas missing from the distribution allowlist',async t=>{
  const f=await fixture(t),directory=path.join(f.root,'extended');await initPlugin(directory);await f.install(directory);const previous=await generatePluginContracts(directory,{check:true});
  const sourcePath=path.join(directory,'dds-dev.json'),source=JSON.parse(await fs.readFile(sourcePath,'utf8'));source.commands.push({...source.commands[0],id:'another'});await fs.writeFile(sourcePath,JSON.stringify(source));await generatePluginContracts(directory,{expectedDigest:previous.digest});
  const report=await doctorPlugin(directory);assert.equal(report.ok,false);assert.equal(report.checks.find(check=>check.id==='generated-package').status,'error');
  const packagePath=path.join(directory,'dds-package.json'),metadata=JSON.parse(await fs.readFile(packagePath,'utf8'));metadata.files.push('generated/schemas/another-input.schema.json');await fs.writeFile(packagePath,JSON.stringify(metadata));assert.equal((await doctorPlugin(directory)).ok,true);
});
