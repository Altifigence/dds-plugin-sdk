import {mkdir, writeFile, realpath, lstat} from 'node:fs/promises';
import path from 'node:path';
import {inspectPluginArchiveBytes} from './publishing.mjs';
import {base64, canonical, clone, digest, exactVersion, fail, fields, portablePath, sha, sourceUrl, string} from './release-internals.mjs';

export const BUNDLE_LIMITS = Object.freeze({packages:32, files:1024, fileBytes:4*1024*1024, unpackedBytes:32*1024*1024, bundleBytes:48*1024*1024});
function packageName(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value) || value === '@altifigence/dds-plugin-sdk') fail('INVALID', 'Unsupported dependency name');
  for (const part of value.replace(/^@/, '').split('/')) portablePath(part);
  return value;
}
function dependencies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > BUNDLE_LIMITS.packages) fail('INVALID', 'Invalid dependency map');
  return Object.fromEntries(Object.keys(value).sort().map(name => [packageName(name), exactVersion(value[name])]));
}
function dependency(input, pinned) {
  fields(input, ['name','version','source','entry','type','dependencies','license','licenseFile','noticeFile','redistributable','files', ...(pinned ? ['sha256'] : [])]);
  const value = clone(input);
  packageName(value.name); exactVersion(value.version); sourceUrl(value.source); portablePath(value.entry); portablePath(value.licenseFile);
  if (value.noticeFile !== null) portablePath(value.noticeFile);
  string(value.license, 'license', 256);
  if (!['module','commonjs'].includes(value.type) || value.redistributable !== true) fail('LICENSE', 'Explicit redistribution approval and supported module type required');
  value.dependencies = dependencies(value.dependencies);
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > BUNDLE_LIMITS.files) fail('LIMIT', 'Invalid dependency file count');
  const names = new Set(); let bytes = 0;
  value.files = value.files.map(file => {
    fields(file, ['path','data']); portablePath(file.path);
    const key = file.path.toLowerCase();
    if (key === 'package.json' || names.has(key)) fail('INVALID', 'Duplicate or generated dependency file');
    names.add(key); const data = base64(file.data, BUNDLE_LIMITS.fileBytes);
    if ((bytes += data.length) > BUNDLE_LIMITS.unpackedBytes) fail('LIMIT', 'Dependency bytes exceeded');
    return {path:file.path, data:file.data};
  }).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const name of names) {
    const parts = name.split('/');
    for (let n=1;n<parts.length;n++) if (names.has(parts.slice(0,n).join('/'))) fail('INVALID', 'Conflicting file and directory');
  }
  for (const required of [value.entry,value.licenseFile,value.noticeFile].filter(x=>x!==null)) {
    const file = value.files.find(f=>f.path===required);
    if (!file || !base64(file.data,BUNDLE_LIMITS.fileBytes).length) fail('LICENSE', 'Entry or license/NOTICE file missing or empty');
  }
  const {sha256, ...content} = value;
  const actual = digest(canonical(content));
  if (pinned && sha(sha256) !== actual) fail('INTEGRITY', 'Dependency digest mismatch');
  return {...content, sha256:actual};
}
/** Lock a reviewed file tree; does not read disk, fetch dependencies, or grant execution. */
export function lockBundleDependency(input) { return dependency(input, false); }
function graph(packages, roots) {
  const map = new Map();
  for (const pkg of packages) {
    if (map.has(pkg.name)) fail('CONFLICT', 'A bundle allows one exact version per dependency name');
    map.set(pkg.name,pkg);
  }
  const visited = new Set(), active = new Set();
  const visit = (name, version) => {
    const pkg = map.get(name);
    if (!pkg || pkg.version !== version) fail('CONFLICT', 'Missing dependency or conflicting exact version');
    if (active.has(name)) fail('CONFLICT', 'Dependency cycles are unsupported');
    if (visited.has(name)) return;
    active.add(name);
    for (const [child, expected] of Object.entries(pkg.dependencies)) visit(child,expected);
    active.delete(name); visited.add(name);
  };
  for (const [name, version] of Object.entries(roots)) visit(name,version);
  if (visited.size !== packages.length) fail('INVALID', 'Unreferenced dependencies are unsupported');
}
function bom(root, packages, roots) {
  const rootRef = `plugin:${root.publisher}/${root.pluginId}@${root.pluginVersion}`;
  const ref = p => `pkg:npm/${p.name.replace('@','%40')}@${p.version}`;
  const refs = new Map(packages.map(p=>[p.name,ref(p)]));
  return {
    bomFormat:'CycloneDX', specVersion:'1.6', version:1,
    metadata:{component:{type:'application', name:`@${root.publisher}/${root.pluginId}`, version:root.pluginVersion, 'bom-ref':rootRef, hashes:[{alg:'SHA-256', content:root.artifact.sha256}], licenses:[{license:{name:root.license}}]}},
    components:packages.map(p=>({type:'library', name:p.name, version:p.version, 'bom-ref':ref(p), purl:ref(p), hashes:[{alg:'SHA-256', content:p.sha256}], licenses:[{license:{name:p.license}}], externalReferences:[{type:'distribution',url:p.source}], properties:[{name:'dds:digest-subject',value:'dds-dependency-tree-v1'},{name:'dds:license-file',value:p.licenseFile},...(p.noticeFile?[{name:'dds:notice-file',value:p.noticeFile}]:[])]})),
    dependencies:[{ref:rootRef,dependsOn:Object.keys(roots).map(n=>refs.get(n))},...packages.map(p=>({ref:ref(p),dependsOn:Object.keys(p.dependencies).map(n=>refs.get(n))}))],
  };
}
function build(input) {
  fields(input, ['schemaVersion','plugin','dependencies','packages']);
  if (input.schemaVersion !== 1) fail('UNSUPPORTED', 'Unsupported bundle version');
  fields(input.plugin, ['archive','metadata','sha256']);
  const plugin = inspectPluginArchiveBytes(base64(input.plugin.archive,12*1024*1024),input.plugin.metadata,{expectedSha256:sha(input.plugin.sha256)});
  const roots = dependencies(input.dependencies);
  if (!Array.isArray(input.packages) || input.packages.length>BUNDLE_LIMITS.packages) fail('LIMIT','Too many packages');
  const packages = input.packages.map(p=>dependency(p,true)).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  graph(packages,roots);
  let count=plugin.files.length, bytes=plugin.receipt.unpackedSize;
  for(const pkg of packages){count+=pkg.files.length+1;for(const file of pkg.files)bytes+=base64(file.data,BUNDLE_LIMITS.fileBytes).length;bytes+=Buffer.byteLength(canonical(packageMetadata(pkg)));}
  if(count>BUNDLE_LIMITS.files||bytes>BUNDLE_LIMITS.unpackedBytes)fail('LIMIT','Bundle expanded file/byte limit exceeded');
  const value={schemaVersion:1,plugin:clone(input.plugin),dependencies:roots,packages};
  const sbom=bom(plugin.receipt,packages,roots);
  return {value,plugin,sbom,bytes,count};
}
function packageMetadata(pkg) {return {name:pkg.name,version:pkg.version,type:pkg.type,main:`./${pkg.entry}`,exports:`./${pkg.entry}`,license:pkg.license,dependencies:pkg.dependencies};}
/** Produces platform-independent UTF-8 JSON bytes with embedded original archive and SBOM. */
export function createPluginBundle(input) {
  const {value,sbom}=build({schemaVersion:1,...input});
  return Uint8Array.from(Buffer.from(canonical({...value,sbom},BUNDLE_LIMITS.bundleBytes)));
}
function inspect(input, options={}) {
  fields(options,[],['expectedSha256']);
  if(!(input instanceof Uint8Array)||input.byteLength>BUNDLE_LIMITS.bundleBytes)fail('LIMIT','Invalid bundle byte count');
  const bytes=Buffer.from(input);const hash=digest(bytes);
  if(options.expectedSha256!==undefined&&sha(options.expectedSha256)!==hash)fail('INTEGRITY','Bundle digest mismatch');
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('INVALID','Invalid bundle JSON');}
  fields(value,['schemaVersion','plugin','dependencies','packages','sbom']);
  if(canonical(value,BUNDLE_LIMITS.bundleBytes)!==bytes.toString('utf8'))fail('INVALID','Bundle must use canonical DDS JSON');
  const {sbom:claimed,...body}=value;const result=build(body);
  if(canonical(result.sbom)!==canonical(claimed))fail('INTEGRITY','SBOM does not match locked graph');
  return {...result,receipt:{schemaVersion:1,sha256:hash,checksumPinned:options.expectedSha256!==undefined,plugin:result.plugin.receipt,dependencies:result.value.packages.map(({files,...p})=>({...p,files:files.map(f=>({path:f.path,size:base64(f.data,BUNDLE_LIMITS.fileBytes).length,sha256:digest(base64(f.data,BUNDLE_LIMITS.fileBytes))}))})),fileCount:result.count,unpackedBytes:result.bytes,sbom:result.sbom,executionAuthorized:false}};
}
/** Verification grants no permissions and never executes contained code. */
export function verifyPluginBundle(bytes,options={}){return clone(inspect(bytes,options).receipt);}
/** The operator supplies a trusted parent and a new destination; this is not an OS sandbox. */
export async function installPluginBundle(bytes,options){
  fields(options,['destination','expectedSha256','approved']);
  if(options.approved!==true)fail('APPROVAL_REQUIRED','Installation approval required');
  const snapshot=inspect(bytes,{expectedSha256:sha(options.expectedSha256)});
  string(options.destination,'destination',4096);
  const requested=path.resolve(options.destination), parent=await realpath(path.dirname(requested));
  if((await lstat(parent)).isSymbolicLink())fail('INVALID','Use a real destination parent');
  const destination=path.join(parent,path.basename(requested));
  await mkdir(destination,{recursive:false});
  // Never remove a failed installation automatically: a receipt/caller may need to inspect it.
  const write=async(name,data)=>{const target=path.join(destination,...name.split('/'));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,data,{flag:'wx',mode:0o600});};
  try{
    for(const file of snapshot.plugin.files)await write(file.path,file.data);
    for(const pkg of snapshot.value.packages){
      const prefix=`node_modules/${pkg.name}/`;
      for(const file of pkg.files)await write(prefix+file.path,base64(file.data,BUNDLE_LIMITS.fileBytes));
      await write(prefix+'package.json',canonical(packageMetadata(pkg))+'\n');
    }
    return {...clone(snapshot.receipt),destination,installed:true,lifecycleScriptsRun:false,networkUsed:false};
  }catch(error){throw Object.assign(new Error('Installation incomplete; inspect or remove the new destination'),{code:'INSTALL_FAILED',destination,cause:error});}
}
