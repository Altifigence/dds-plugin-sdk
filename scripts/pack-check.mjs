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
  for (const required of ['LICENSE', 'NOTICE', 'README.md', 'src/index.mjs', 'src/index.d.mts', 'src/testing.mjs', 'schemas/manifest.schema.json', 'examples/hello-diagnostics/plugin.mjs']) {
    assert.ok(paths.includes(required), `Missing ${required} in package`);
  }
  for (const path of paths) assert.match(path, /^(?:package\.json|README\.md|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE|NOTICE|(?:src|schemas|docs|examples)\/)/, `Unexpected public file ${path}`);
  const consumer = join(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({name: 'sdk-external-smoke', version: '1.0.0', private: true, type: 'module'}));
  run(process.execPath, [npmCli, 'install', join(temporary, packed.filename), '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], consumer);
  const installed = join(consumer, 'node_modules', '@altifigence', 'dds-plugin-sdk');
  assert.equal(await realpath(installed), installed, 'Packed install must be a real directory, not a source symlink');
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.name, '@altifigence/dds-plugin-sdk');
  assert.equal(metadata.version, '0.1.0');
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0);
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
assert.equal(SCHEMAS.manifest.properties.entry.type, 'string');
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
  await cp(join(root, 'tests', 'types', 'consumer.mts'), join(consumer, 'consumer.mts'));
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
