import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this check with npm run pack:check');
// Windows runners can expose TEMP through an 8.3 alias (for example RUNNER~1).
// Canonicalize our fresh parent before checking that npm installed real files.
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'dds-sdk-consumer-')));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000});
  if (result.error || result.status !== 0) throw new Error(result.error?.message || `${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary], root))[0];
  const paths = packed.files.map(file => file.path);
  for (const required of ['LICENSE', 'NOTICE', 'README.md', 'src/index.mjs', 'src/index.d.mts', 'src/testing.mjs', 'schemas/manifest.schema.json', 'examples/hello-diagnostics/plugin.mjs', 'src/host.mjs', 'src/themes.mjs', 'src/workspace-node.mjs', 'src/workspace-client.mjs', 'src/consent.mjs', 'src/publishing.mjs', 'bin/dds-plugin.mjs', 'templates/LICENSE.proprietary.example.txt', 'examples/publishable-plugin/LICENSE']) {
    assert.ok(paths.includes(required), `Missing ${required} in package`);
  }
  assert.deepEqual([...paths].sort(), JSON.parse(await readFile(join(root, 'PUBLIC_SURFACE.json'), 'utf8')).packageFiles.slice().sort(), 'Packed SDK must match the reviewed inventory');
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({name: 'sdk-external-smoke', version: '1.0.0', private: true, type: 'module'}));
  run(process.execPath, [npmCli, 'install', join(temporary, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
  const installed = join(consumer, 'node_modules', '@altifigence', 'dds-plugin-sdk');
  assert.equal(await realpath(installed), installed, 'Packed install must be a real directory, not a source symlink');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@altifigence/dds-plugin-sdk');
  assert.equal(metadata.version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0);
  const devCli = join(installed, 'bin', 'dds-plugin.mjs');
  const scaffold = JSON.parse(run(process.execPath, [devCli, 'init', 'scaffold', '--id', 'packed-scaffold', '--publisher', 'example'], consumer));
  assert.equal(scaffold.sdkVersion, metadata.version);
  const scaffoldMetadata = JSON.parse(await readFile(join(consumer, 'scaffold', 'package.json'), 'utf8'));
  assert.match(scaffoldMetadata.dependencies[metadata.name], new RegExp(`/v${metadata.version.replaceAll('.', '\\.')}\\/`));
  const diagnosed = JSON.parse(run(process.execPath, [devCli, 'doctor', 'scaffold', '--json'], consumer));
  assert.equal(diagnosed.ok, true);
  run(process.execPath, ['--test', 'plugin.test.mjs'], join(consumer, 'scaffold'));
  for (const job of [false, true]) {
    const output = run(process.execPath, [devCli, 'dev', 'scaffold', '--trust-local-code', '--command', 'greet', '--input', JSON.stringify({name:'Packed'}), ...(job ? ['--job'] : [])], consumer);
    assert.ok(output.includes('Hello, Packed!')); assert.ok(output.includes('"ok": true'));
  }
  await cp(join(installed, 'examples', 'command-jobs'), join(consumer, 'job-example'), {recursive:true});
  assert.match(run(process.execPath, ['job-example/run.mjs'], consumer), /pinned result file verified/);
  await cp(join(installed, 'examples', 'durable-jobs'), join(consumer, 'durable-job-example'), {recursive:true});
  assert.match(run(process.execPath, ['durable-job-example/run.mjs'], consumer), /killed child, current authorization and no automatic replay verified/);
  await cp(join(installed, 'examples', 'workspace-observation'), join(consumer, 'observation-example'), {recursive:true});
  assert.match(run(process.execPath, ['observation-example/run.mjs'], consumer), /file changes, retained draft and resumed job verified/);
  for (const entry of Object.values(metadata.exports)) {
    for (const file of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      assert.ok(paths.includes(file.replace(/^\.\//, '')), `Export ${file} is absent from the archive`);
    }
  }
  await cp(join(installed, 'examples', 'hello-diagnostics'), join(consumer, 'example'), {recursive: true});
  const output = run(process.execPath, ['example/run.mjs'], consumer);
  assert.equal(output.replaceAll('\r\n', '\n'), 'Hello Diagnostics: 1 diagnostic\ninfo 2:1 Resolve this TODO before sharing the document.\n');
  await writeFile(join(consumer, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { ErrorCode, createDiagnosticsResult, parseManifest } from '@altifigence/dds-plugin-sdk';
import { createTestHost } from '@altifigence/dds-plugin-sdk/testing';
import { SCHEMAS } from '@altifigence/dds-plugin-sdk/schemas';
import plugin from './example/plugin.mjs';
assert.equal(parseManifest(plugin.manifest).protocolVersion, 1);
assert.equal(SCHEMAS.manifest.oneOf[0].properties.entry.type, 'string');
const host = createTestHost();
await host.activate(plugin);
host.setDocument({uri:'memory:///packed.txt', languageId:'plaintext', modelVersion:1, workspaceRevision:'v1', text:'TODO'});
const result = await host.requestDiagnostics();
assert.equal(result.diagnostics.length, 1);
assert.equal(result.snapshot.uri, 'memory:///packed.txt');
host.setDocument({uri:'memory:///packed.txt', languageId:'plaintext', modelVersion:2, workspaceRevision:'v1', text:'done'});
assert.equal((await host.requestDiagnostics()).diagnostics.length, 0);
host.dispose();
assert.equal(ErrorCode.CANCELLED, 'cancelled');
assert.equal(typeof createDiagnosticsResult, 'function');
`);
  run(process.execPath, ['smoke.mjs'], consumer);
  await cp(join(installed, 'examples', 'hello-language'), join(consumer, 'language-example'), {recursive: true});
  run(process.execPath, ['language-example/run.mjs'], consumer);
  await cp(join(installed, 'examples', 'project-session'), join(consumer, 'project-example'), {recursive: true});
  run(process.execPath, ['project-example/run.mjs'], consumer);
  // Package and install a real independent plugin. npm sees generated metadata;
  // the explicit SDK peer is already installed from the archive under test.
  await cp(join(installed, 'examples', 'publishable-plugin'), join(consumer, 'publishable-plugin'), {recursive: true});
  const cli = join(installed, 'bin', 'dds-plugin.mjs');
  const report = JSON.parse(run(process.execPath, [cli, 'validate', 'publishable-plugin'], consumer));
  assert.equal(report.sourceVisibility, 'open');
  const pluginArchive = JSON.parse(run(process.execPath, [cli, 'pack', 'publishable-plugin', '--out', 'plugin-dist'], consumer));
  const verified = JSON.parse(run(process.execPath, [cli, 'verify', pluginArchive.archivePath, '--sha256', pluginArchive.artifact.sha256], consumer));
  assert.equal(verified.checksumPinned, true);
  assert.deepEqual(verified.files, pluginArchive.files);
  const verificationExample = run(process.execPath, [join(installed, 'examples', 'release-verification', 'run.mjs')], consumer);
  assert.match(verificationExample, /hash pin and tampering check passed/);
  run(process.execPath, [npmCli, 'install', pluginArchive.archivePath, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
  const closedRoot = join(consumer, 'closed-plugin');
  await cp(join(consumer, 'publishable-plugin'), closedRoot, {recursive: true});
  const closedManifest = JSON.parse(await readFile(join(closedRoot, 'plugin.json'), 'utf8'));
  closedManifest.id = 'hello-private';
  closedManifest.license = 'LicenseRef-Example-Proprietary';
  closedManifest.source = {visibility: 'closed', licenseFile: 'LICENSE.proprietary'};
  const closedDisclosure = JSON.parse(await readFile(join(closedRoot, 'disclosure.json'), 'utf8'));
  Object.assign(closedDisclosure, {pluginId: closedManifest.id, license: closedManifest.license, sourceVisibility: 'closed'});
  const closedFiles = JSON.parse(await readFile(join(closedRoot, 'dds-package.json'), 'utf8'));
  closedFiles.files.push('LICENSE.proprietary');
  await writeFile(join(closedRoot, 'plugin.json'), JSON.stringify(closedManifest));
  await writeFile(join(closedRoot, 'disclosure.json'), JSON.stringify(closedDisclosure));
  await writeFile(join(closedRoot, 'dds-package.json'), JSON.stringify(closedFiles));
  await writeFile(join(closedRoot, 'LICENSE.proprietary'), 'Packaging test fixture only. Rights in separately licensed Apache example code and the SDK remain under their existing LICENSE and NOTICE. No production plugin is licensed by this test.\n');
  const privateArchive = JSON.parse(run(process.execPath, [cli, 'pack', 'closed-plugin', '--out', 'plugin-dist'], consumer));
  assert.equal(privateArchive.sourceVisibility, 'closed');
  run(process.execPath, [npmCli, 'install', privateArchive.archivePath, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
  await writeFile(join(consumer, 'command-smoke.mjs'), `
import assert from 'node:assert/strict';
import plugin from '@example/hello-publisher';
import privatePlugin from '@example/hello-private';
import { createPluginHost } from '@altifigence/dds-plugin-sdk';
import { parseTheme, serializeThemeXml } from '@altifigence/dds-plugin-sdk/themes';
import { createNotice } from '@altifigence/dds-plugin-sdk/consent';
const host = createPluginHost({hostId:'workspace-host',grants:[]});
await host.activate(plugin);
assert.equal(host.listCommands()[0].id, 'greet');
assert.equal((await host.executeCommand('hello-publisher','greet',{name:'Ada'})).message, 'Hello, Ada!');
await host.activate(privatePlugin);
assert.equal(privatePlugin.manifest.source.visibility,'closed');
assert.equal((await host.executeCommand('hello-private','greet',{name:'Inez'})).message, 'Hello, Inez!');
host.dispose();
const palette={backdrop:'#111111',navigation:'#222222',tool:'#333333',main:'#444444',text:'#ffffff',muted:'#aaaaaa'};
assert.ok(serializeThemeXml(parseTheme({name:'Packed Theme',colors:{light:palette,dark:palette}})).includes('Packed Theme'));
const notice=await createNotice({id:'packed-example',version:'1.0.0',locale:'en',purpose:'noticeAcknowledgement',text:'This example records no decision.'});
assert.equal(notice.text,'This example records no decision.');
`);
  run(process.execPath, ['command-smoke.mjs'], consumer);
  await cp(join(installed, 'examples', 'user-workspace'), join(consumer, 'user-host'), {recursive: true});
  await writeFile(join(consumer, 'workspace-smoke.mjs'), `
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createWorkspaceClient} from '@altifigence/dds-plugin-sdk/workspace-client';
const token='packed-consumer-fixture-token-0123456789';
const child=spawn(process.execPath,['user-host/server.mjs'],{env:{...process.env,DDS_WORKSPACE_TOKEN:token,DDS_WORKSPACE_PORT:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let client;
try {
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Example server did not start')),10000);
    let output='';
    child.once('error',reject);
    child.stdout.on('data',chunk=>{output+=chunk;const match=/Workspace server: (http:[^\\s]+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1]);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Example server exited'));});
  });
  client=createWorkspaceClient({url,token});
  const hello=await client.connect();
  const plugin=hello.plugins[0];
  assert.ok(plugin.licenseText.includes('Apache License'));
  assert.ok((await client.listFiles()).entries.some(entry=>entry.path==='design.sv'));
  const first=await client.readFile('design.sv');
  const source=first.content+'\\n// Unicode: 한글 é 😃\\n';
  await client.writeFile('design.sv',source,first.revision);
  await assert.rejects(client.writeFile('design.sv','stale',first.revision),{code:'conflict'});
  const result=await client.runCommand(plugin.manifest.id,'inspect',{path:'design.sv'},plugin.artifactSha256);
  assert.ok(JSON.stringify(result).includes('module-counter'));
  assert.equal((await client.readFile('design.sv')).content,source);
} finally {
  client?.dispose();
  if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill();await closed;}
}
`);
  run(process.execPath, ['workspace-smoke.mjs'], consumer);
  await cp(join(root, 'tests', 'types', 'consumer.mts'), join(consumer, 'consumer.mts'));
  await cp(join(root, 'tests', 'types', 'public-apis.mts'), join(consumer, 'public-apis.mts'));
  await cp(join(root, 'tests', 'types', 'core-v2.mts'), join(consumer, 'core-v2.mts'));
  await cp(join(root, 'tests', 'types', 'language.mts'), join(consumer, 'language.mts'));
  await cp(join(root, 'tests', 'types', 'workspace-project.mts'), join(consumer, 'workspace-project.mts'));
  await cp(join(root, 'tests', 'types', 'jobs-devtools.mts'), join(consumer, 'jobs-devtools.mts'));
  await cp(join(root, 'tests', 'types', 'workspace-observation.mts'), join(consumer, 'workspace-observation.mts'));
  await cp(join(root, 'tests', 'types', 'artifacts.mts'), join(consumer, 'artifacts.mts'));
  run(process.execPath, [join(installed, 'examples', 'binary-artifacts', 'run.mjs')], consumer);
  await cp(join(root, 'tests', 'types', 'tsconfig.json'), join(consumer, 'tsconfig.json'));
  const typescript = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  run(process.execPath, [typescript, '--noEmit', '-p', 'tsconfig.json'], consumer);
  console.log(`Packed consumer verified: ${packed.filename}; ${packed.size} compressed bytes; ${packed.unpackedSize} unpacked bytes; ${paths.length} files`);
  console.log(`Integrity: ${packed.integrity}`);
} finally {
  // Remove only the freshly created disposable consumer and tarball directory.
  const actual = await realpath(temporary);
  const parent = await realpath(tmpdir());
  assert.equal(dirname(actual), parent);
  assert.ok(actual.startsWith(join(parent, 'dds-sdk-consumer-')));
  await rm(actual, {recursive: true});
}
