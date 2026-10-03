import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, realpath, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { packPlugin, validatePluginPackage } from '../src/publishing.mjs';

const manifest = {
  manifestVersion: 2, id: 'hello', name: 'Hello', publisher: 'example', version: '1.0.0',
  protocolVersion: 1, entry: './plugin.mjs', capabilities: ['commands'], permissions: [],
  runtime: 'workspace', supportedHosts: ['workspace-host'], license: 'Apache-2.0',
  source: {visibility: 'open', repository: 'https://github.com/Altifigence/dds-plugin-sdk', licenseFile: 'LICENSE'},
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, overrides = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'dds-publishing-')));
  t.after(async () => {
    assert.equal(path.dirname(directory), await realpath(tmpdir()));
    assert.ok(path.basename(directory).startsWith('dds-publishing-'));
    await rm(directory, {recursive: true});
  });
  const plugin = {...manifest, ...overrides};
  const files = ['plugin.json', 'plugin.mjs', 'LICENSE', 'disclosure.json'];
  const config = {schemaVersion: 1, files};
  const disclosure = {
    schemaVersion: 1, publisher: plugin.publisher, pluginId: plugin.id, pluginVersion: plugin.version,
    license: plugin.license, sourceVisibility: plugin.source.visibility,
    supportUrl: 'https://github.com/Altifigence/dds-plugin-sdk/issues', dataUse: 'Uses only explicit command input.', backends: [],
  };
  await writeFile(path.join(directory, 'dds-package.json'), JSON.stringify(config));
  await writeFile(path.join(directory, 'plugin.json'), JSON.stringify(plugin));
  await writeFile(path.join(directory, 'disclosure.json'), JSON.stringify(disclosure));
  await writeFile(path.join(directory, 'plugin.mjs'), 'throw new Error("Packaging must not execute me");\n');
  await writeFile(path.join(directory, 'LICENSE'), plugin.license === 'Apache-2.0' ? 'Apache License Version 2.0 test fixture' : 'Test fixture: All rights reserved.');
  return {directory, plugin, config, disclosure};
}
function untar(bytes) {
  const tar = gunzipSync(bytes);
  const entries = new Map();
  for (let cursor = 0; cursor < tar.length && tar[cursor];) {
    const header = tar.subarray(cursor, cursor + 512);
    const field = (offset, length) => header.subarray(offset, offset + length).toString('utf8').split('\0')[0];
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    const size = Number.parseInt(field(124, 12), 8);
    const checksum = Number.parseInt(field(148, 8), 8);
    assert.equal(header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0), checksum);
    assert.equal(field(257, 6), 'ustar');
    entries.set(name, tar.subarray(cursor + 512, cursor + 512 + size));
    cursor += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
test('open and proprietary packages use explicit files, never execute code, and preserve license identity', async t => {
  for (const visibility of ['open', 'closed']) {
    const license = visibility === 'open' ? 'Apache-2.0' : 'LicenseRef-Example-Proprietary';
    const {directory} = await fixture(t, {license, source: {visibility, licenseFile: 'LICENSE'}});
    await writeFile(path.join(directory, 'private-source.ts'), 'not distributable');
    await writeFile(path.join(directory, '.env'), 'SECRET=not-distributable');
    const report = await validatePluginPackage(directory);
    assert.equal(report.sourceVisibility, visibility);
    assert.equal(report.license, license);
    assert.equal(report.files.length, 6);
    const packed = await packPlugin(directory, {out: path.join(directory, 'dist')});
    const bytes = await readFile(packed.archivePath);
    assert.equal(digest(bytes), packed.artifact.sha256);
    const archive = untar(bytes);
    assert.deepEqual([...archive.keys()], report.files.map(file => `package/${file.path}`));
    for (const file of report.files) assert.equal(digest(archive.get(`package/${file.path}`)), file.sha256);
    assert.ok(![...archive.keys()].some(name => /private-source|\.env/.test(name)));
    const npmMetadata = JSON.parse(archive.get('package/package.json'));
    assert.equal(npmMetadata.name, '@example/hello');
    assert.equal(npmMetadata.exports, './plugin.mjs');
    assert.equal(npmMetadata.scripts, undefined);
    assert.equal(JSON.parse(await readFile(packed.metadataPath, 'utf8')).artifact.sha256, packed.artifact.sha256);
  }
});
test('packages are byte deterministic and an existing release cannot be overwritten', async t => {
  const {directory} = await fixture(t);
  const first = await packPlugin(directory, {out: path.join(directory, 'one')});
  const second = await packPlugin(directory, {out: path.join(directory, 'two')});
  assert.equal(first.artifact.sha256, second.artifact.sha256);
  await assert.rejects(packPlugin(directory, {out: path.join(directory, 'one')}), {code: 'EEXIST'});
  assert.equal(digest(await readFile(first.archivePath)), first.artifact.sha256);
});
test('manifest/disclosure mismatch, missing license, private files and traversal fail closed', async t => {
  const {directory, disclosure, config} = await fixture(t);
  await writeFile(path.join(directory, 'disclosure.json'), JSON.stringify({...disclosure, sourceVisibility: 'closed'}));
  await assert.rejects(validatePluginPackage(directory), /visibility/);
  await writeFile(path.join(directory, 'disclosure.json'), JSON.stringify(disclosure));
  for (const invalid of ['../escape', '/absolute', 'dir\\file', 'file:stream', '.env', 'x/.git/config', 'id_rsa', 'private.pem', 'NUL', 'trailing.', 'dds-package.json', 'package.json']) {
    await writeFile(path.join(directory, 'dds-package.json'), JSON.stringify({...config, files: [...config.files, invalid]}));
    await assert.rejects(validatePluginPackage(directory));
  }
  await writeFile(path.join(directory, 'dds-package.json'), JSON.stringify({...config, files: config.files.filter(file => file !== 'LICENSE')}));
  await assert.rejects(validatePluginPackage(directory), /license file/);
});
test('template disclosure, credentials and oversized archive inputs are rejected', async t => {
  const {directory, disclosure, config} = await fixture(t);
  for (const invalid of [{dataUse: 'TODO'}, {supportUrl: 'https://user:password@example.org/'}, {secret: 'should never be accepted'}]) {
    await writeFile(path.join(directory, 'disclosure.json'), JSON.stringify({...disclosure, ...invalid}));
    await assert.rejects(validatePluginPackage(directory));
  }
  await writeFile(path.join(directory, 'disclosure.json'), JSON.stringify(disclosure));
  await writeFile(path.join(directory, 'large.bin'), Buffer.alloc(4 * 1024 * 1024 + 1));
  await writeFile(path.join(directory, 'dds-package.json'), JSON.stringify({...config, files: [...config.files, 'large.bin']}));
  await assert.rejects(validatePluginPackage(directory), /byte limit/);
});
test('directory links cannot pull external contents into a release', async t => {
  const {directory, config} = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside.directory, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(directory, 'dds-package.json'), JSON.stringify({...config, files: [...config.files, 'linked/LICENSE']}));
  await assert.rejects(validatePluginPackage(directory), /regular files/);
  await mkdir(path.join(directory, 'nested'));
});
test('validation rejects paths and release names that cannot be packed portably', async t => {
  const {directory, config} = await fixture(t);
  const longName = `${'a'.repeat(101)}.txt`;
  await writeFile(path.join(directory, longName), 'data');
  await writeFile(path.join(directory, 'dds-package.json'), JSON.stringify({...config, files: [...config.files, longName]}));
  await assert.rejects(validatePluginPackage(directory), /portable archive limits/);
  const longIdentity = await fixture(t, {publisher: 'p'.repeat(105), id: 'i'.repeat(105), version: `1.0.0+${'x'.repeat(50)}`});
  await assert.rejects(validatePluginPackage(longIdentity.directory), /release filename limit/);
});

test('credentials in allowed source files fail without echoing the value or creating a release', async t => {
  const {directory} = await fixture(t);
  const candidates = [
    ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    ['gh', 'p_', 'a'.repeat(36)].join(''),
    ['github_', 'pat_', 'b'.repeat(40)].join(''),
    ['AK', 'IA', 'Z'.repeat(16)].join(''),
  ];
  for (const value of candidates) {
    await writeFile(path.join(directory, 'plugin.mjs'), `export const accidental = ${JSON.stringify(value)};`);
    const safeFailure = error => /recognizable credential/.test(error.message) && !error.message.includes(value);
    await assert.rejects(validatePluginPackage(directory), safeFailure);
    await assert.rejects(packPlugin(directory, {out:path.join(directory, 'dist')}), safeFailure);
  }
  await writeFile(path.join(directory, 'plugin.mjs'), 'export const message = "request a token through the host";');
  assert.equal((await validatePluginPackage(directory)).pluginId, 'hello');
});

test('cloud and SSH credential directories cannot be allowed into a package', async t => {
  const {directory, config} = await fixture(t);
  for (const name of ['.aws/credentials', '.azure/accessTokens.json', '.ssh/config', '.gnupg/keyring', '.kube/config', '.docker/config.json', '.netrc']) {
    await writeFile(path.join(directory, 'dds-package.json'), JSON.stringify({...config, files:[...config.files, name]}));
    await assert.rejects(validatePluginPackage(directory), /private configuration/);
  }
});
