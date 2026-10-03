import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createNodeWorkspace} from '../src/workspace-node.mjs';
async function fixture(t,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dds-workspace-files-'));
  const workspace=await createNodeWorkspace({root,...options});
  t.after(async()=>{workspace.dispose();assert.ok(root.startsWith(path.join(os.tmpdir(),'dds-workspace-files-')));await fs.rm(root,{recursive:true});});
  return{root,workspace};
}
test('real files edit with serialized CAS and no-overwrite create',async t=>{
  const {root,workspace}=await fixture(t);await fs.writeFile(path.join(root,'top.sv'),'module top; endmodule\n');
  const first=await workspace.readFile('top.sv');
  const results=await Promise.allSettled([workspace.writeFile('top.sv','one',{expectedRevision:first.revision}),workspace.writeFile('top.sv','two',{expectedRevision:first.revision})]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.find(value=>value.status==='rejected').reason.code,'conflict');
  assert.equal(await fs.readFile(path.join(root,'top.sv'),'utf8'),'one');
  await assert.rejects(workspace.writeFile('top.sv','new',{expectedRevision:null}),{code:'conflict'});
  await workspace.writeFile('new.sv','new',{expectedRevision:null});await assert.rejects(workspace.writeFile('new.sv','bad',{expectedRevision:null}),{code:'conflict'});
  assert.equal((await fs.readdir(root)).some(name=>name.startsWith('.dds-write-')),false);
});
test('dotfiles/listing policy, management and nonrecursive removal',async t=>{
  const {root,workspace}=await fixture(t);await fs.mkdir(path.join(root,'.vscode'));await fs.writeFile(path.join(root,'.vscode','settings.json'),'{}');
  await fs.writeFile(path.join(root,'.gitignore'),'build/');await fs.writeFile(path.join(root,'.env'),'SECRET=fixture');await fs.mkdir(path.join(root,'.git'));
  assert.deepEqual((await workspace.listFiles()).map(value=>value.path),['.gitignore','.vscode']);assert.equal((await workspace.readFile('.vscode/settings.json')).content,'{}');
  await assert.rejects(workspace.readFile('.env'),{code:'unsafe_path'});await assert.rejects(workspace.readFile('../outside'),{code:'unsafe_path'});
  await workspace.mkdir('rtl');await workspace.writeFile('rtl/one.sv','one',{expectedRevision:null});await workspace.writeFile('rtl/two.sv','two',{expectedRevision:null});
  await assert.rejects(workspace.rename('rtl/one.sv','rtl/two.sv'),{code:'conflict'});await assert.rejects(workspace.remove('rtl'),{code:'conflict'});await assert.rejects(workspace.rename('rtl','renamed'),{code:'unsupported'});
  const one=await workspace.readFile('rtl/one.sv');await workspace.rename('rtl/one.sv','rtl/three.sv',{expectedRevision:one.revision});await workspace.remove('rtl/three.sv',{expectedRevision:one.revision});
});
test('junction/symlink containment, invalid UTF-8, size limits and read-only mode',async t=>{
  const {root,workspace}=await fixture(t);const outside=await fs.mkdtemp(path.join(os.tmpdir(),'dds-workspace-outside-'));
  t.after(async()=>{assert.ok(outside.startsWith(path.join(os.tmpdir(),'dds-workspace-outside-')));await fs.rm(outside,{recursive:true});});
  await fs.writeFile(path.join(outside,'secret.txt'),'fixture-secret');
  await fs.symlink(outside,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(workspace.readFile('escape/secret.txt'),{code:'unsafe_path'});assert.equal((await workspace.listFiles()).some(value=>value.path==='escape'),false);
  await fs.writeFile(path.join(root,'large.txt'),Buffer.alloc(262145));await assert.rejects(workspace.readFile('large.txt'),{code:'budget_exceeded'});
  await fs.writeFile(path.join(root,'bad.txt'),Buffer.from([0xff]));await assert.rejects(workspace.readFile('bad.txt'),{code:'invalid_request'});
  await assert.rejects(workspace.writeFile('large-new.txt','한'.repeat(100_000),{expectedRevision:null}),{code:'budget_exceeded'});
  const readonly=await createNodeWorkspace({root,writable:false});t.after(()=>readonly.dispose());await assert.rejects(readonly.writeFile('new.txt','x',{expectedRevision:null}),{code:'permission_denied'});
  const controller=new AbortController();controller.abort();await assert.rejects(workspace.readFile('bad.txt',{signal:controller.signal}),{code:'cancelled'});
});
