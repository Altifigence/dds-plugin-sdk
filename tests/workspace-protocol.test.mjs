import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyWorkspaceJson,parseWorkspaceHello,parseWorkspaceMethodResult,requireWorkspacePath,isProtectedWorkspaceComponent} from '../src/workspace-protocol.mjs';
import {normalizeWorkspaceUrl} from '../src/workspace-client.mjs';
const uuid='a784ff42-e986-47b1-9140-b10f8ba68ca8';
const manifest={manifestVersion:2,id:'test.workspace',name:'Test',publisher:'test',version:'0.2.0',protocolVersion:1,entry:'./plugin.mjs',runtime:'workspace',capabilities:['commands'],permissions:[],supportedHosts:['workspace-host'],license:'Apache-2.0',source:{visibility:'open',licenseFile:'LICENSE'}};
const hello=()=>({hostId:'workspace-host',hostVersion:'0.2.0',protocolVersion:1,workspace:{id:uuid,name:'Test',generation:uuid},capabilities:{read:true,write:true,manage:true,commands:true},plugins:[{manifest,artifactSha256:'a'.repeat(64),commands:[{pluginId:manifest.id,id:'run',title:'Run'}]}],notice:{id:'test',version:'1',text:'Test notice',sha256:createHash('sha256').update('Test notice').digest('hex')}});
test('JSON byte accounting stops before later fields and does not invoke accessors',()=>{
  let accesses=0;const input={first:'x'.repeat(100),later:{get value(){accesses++;throw new Error('secret');}}};
  assert.throws(()=>copyWorkspaceJson(input,{maxBytes:80}),{code:'budget_exceeded'});assert.equal(accesses,0);
  assert.throws(()=>copyWorkspaceJson(Array(1_000).fill('한'.repeat(100))),{code:'budget_exceeded'});
  assert.throws(()=>copyWorkspaceJson({get value(){accesses++;return 1;}}),{code:'invalid_request'});assert.equal(accesses,0);
  assert.throws(()=>copyWorkspaceJson({a:'\ud800'}),{code:'invalid_request'});
});
test('full manifests and optional command parameters use core parity',()=>{
  const value=hello();assert.equal(parseWorkspaceHello(value).plugins[0].commands[0].parameters,undefined);
  value.plugins[0].commands[0].parameters=Array.from({length:32},(_,i)=>({name:`p${i}`,label:`Parameter ${i}`,type:'string',required:false,choices:['yes','no']}));
  assert.equal(parseWorkspaceHello(value).plugins[0].commands[0].parameters.length,32);
  value.plugins[0].commands[0].parameters[0].choices=[1];assert.throws(()=>parseWorkspaceHello(value),{code:'invalid_request'});
  const bad=hello();bad.plugins[0].manifest={...manifest,permissions:['all.files']};assert.throws(()=>parseWorkspaceHello(bad),{code:'invalid_request'});
  assert.throws(()=>parseWorkspaceMethodResult('plugins.list',{plugins:[{manifest:{id:'partial'},artifactSha256:'a'.repeat(64),commands:[]}]}),{code:'invalid_request'});
});
test('ordinary project dotfiles work while precise secret/control paths fail',()=>{
  for(const path of ['.gitignore','.vscode/settings.json','.github/workflows/build.yml','rtl/top.sv'])assert.equal(requireWorkspacePath(path),path);
  for(const path of ['../outside','rtl/../secret','/tmp/file','C:/file','a\\b','.git/config','.ENV.local','rtl/private.pem','.dds-write-abc','.ssh/id_ed25519'])assert.throws(()=>requireWorkspacePath(path),{code:'unsafe_path'});
  assert.equal(isProtectedWorkspaceComponent('.vscode'),false);assert.equal(isProtectedWorkspaceComponent('.env'),true);
});
test('URL parity rejects shorthand, normalization tricks, credentials and remote HTTP',()=>{
  for(const value of ['http://127.0.0.1:4777','http://127.2.3.4','http://localhost','http://[::1]:4777','https://host.example/dds/workspace/v1'])assert.ok(normalizeWorkspaceUrl(value).endsWith('/dds/workspace/v1'));
  for(const value of ['http://127.1','http://2130706433','http://0x7f000001','http://127.000.0.1','http://192.168.1.1',' http://localhost','http://local\nhost','http://localhost\\anything','http:localhost','https://user:secret@host.example','https://host.example/?token=secret','https://host.example/#secret','https://host.example/foo/..'])assert.throws(()=>normalizeWorkspaceUrl(value),{code:'invalid_request'});
});
