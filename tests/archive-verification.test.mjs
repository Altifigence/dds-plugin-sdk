import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, readFile, writeFile, readdir, rm, link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';
import {packPlugin, validatePluginPackage, verifyPluginArchive} from '../src/publishing.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const cli = new URL('../bin/dds-plugin.mjs', import.meta.url);
const publicLicense = 'Apache License Version 2.0 test fixture';
async function fixture(t, visibility = 'open') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dds-archive-')));
  t.after(async () => {
    assert.equal(path.dirname(root), await realpath(tmpdir()));
    assert.ok(path.basename(root).startsWith('dds-archive-'));
    await rm(root, {recursive: true});
  });
  const manifest = {
    manifestVersion: 2, id: 'verify-example', name: 'Verify example', publisher: 'example', version: '1.0.0',
    protocolVersion: 1, entry: './plugin.mjs', capabilities: ['commands'], permissions: [],
    runtime: 'workspace', supportedHosts: ['workspace-host'],
    license: visibility === 'open' ? 'Apache-2.0' : 'LicenseRef-Example-Proprietary',
    source: {visibility, licenseFile: 'LICENSE'},
  };
  const config = {schemaVersion: 1, files: ['plugin.json', 'plugin.mjs', 'LICENSE', 'disclosure.json']};
  const disclosure = {
    schemaVersion: 1, publisher: manifest.publisher, pluginId: manifest.id, pluginVersion: manifest.version,
    license: manifest.license, sourceVisibility: visibility,
    supportUrl: 'https://example.org/support', dataUse: 'Only explicit input.', backends: [],
  };
  await writeFile(path.join(root, 'dds-package.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'disclosure.json'), JSON.stringify(disclosure));
  await writeFile(path.join(root, 'plugin.mjs'), 'throw new Error("This must never execute during verification");\n');
  await writeFile(path.join(root, 'LICENSE'), visibility === 'open' ? publicLicense : 'Test fixture. All rights reserved.');
  const packed = await packPlugin(root, {out: path.join(root, 'dist')});
  const archive = await readFile(packed.archivePath);
  const metadata = JSON.parse(await readFile(packed.metadataPath, 'utf8'));
  return {root, packed, archive, metadata, config};
}

// These test helpers rewrite actual pack output to model a distributor that can
// replace both the archive and its adjacent, unauthenticated checksum metadata.
function entries(archive) {
  const tar = gunzipSync(archive);
  const result = [];
  for (let at = 0; tar[at];) {
    const header = Buffer.from(tar.subarray(at, at + 512));
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
    result.push({header, bytes: Buffer.from(tar.subarray(at + 512, at + 512 + size))});
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}
const name = entry => entry.header.subarray(0, 100).toString('utf8').split('\0')[0].slice(8);
function sealHeader(header) {
  header.fill(32, 148, 156);
  header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
}
function setName(entry, filename) {
  entry.header.fill(0, 0, 100);
  entry.header.write(filename, 0, 100, 'utf8');
  sealHeader(entry.header);
}
function build(list, trailer = Buffer.alloc(1024)) {
  const chunks = [];
  for (const entry of list) {
    entry.header.write(entry.bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    sealHeader(entry.header);
    chunks.push(entry.header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, trailer]), {level: 9});
}
async function installPair(f, archive, change = () => {}) {
  const metadata = structuredClone(f.metadata);
  metadata.artifact.size = archive.length;
  metadata.artifact.sha256 = hash(archive);
  change(metadata);
  await writeFile(f.packed.archivePath, archive);
  await writeFile(f.packed.metadataPath, JSON.stringify(metadata));
}
function reflectFiles(metadata, list) {
  metadata.files = list.map(entry => ({path: name(entry), size: entry.bytes.length, sha256: hash(entry.bytes)}))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  metadata.unpackedSize = metadata.files.reduce((sum, file) => sum + file.size, 0);
}

test('verifies open and proprietary releases without importing code, extracting files or granting trust', async t => {
  for (const visibility of ['open', 'closed']) {
    const f = await fixture(t, visibility);
    const before = await readdir(f.root, {recursive: true});
    const unpinned = await verifyPluginArchive(f.packed.archivePath);
    assert.equal(unpinned.checksumPinned, false);
    assert.equal(unpinned.sourceVisibility, visibility);
    const verified = await verifyPluginArchive(f.packed.archivePath, {expectedSha256: f.packed.artifact.sha256});
    assert.equal(verified.checksumPinned, true);
    assert.deepEqual(verified.artifact, f.packed.artifact);
    assert.deepEqual(verified.files, f.packed.files);
    assert.ok(Object.isFrozen(verified) && Object.isFrozen(verified.artifact) && Object.isFrozen(verified.files[0]));
    assert.deepEqual(await readdir(f.root, {recursive: true}), before);
  }
});

for (const range of ['>=0.3.0 <0.4.0', '>=0.4.0 <0.5.0', '>=0.5.0 <0.6.0', '>=0.6.0 <0.7.0', '>=0.7.0 <0.8.0', '>=0.8.0 <0.9.0']) test(`previous ${range} metadata is verified without broadening its declared peer range`, async t => {
  const f = await fixture(t);
  const list = entries(f.archive), item = list.find(entry => name(entry) === 'package.json');
  const metadata = JSON.parse(item.bytes); metadata.peerDependencies['@altifigence/dds-plugin-sdk'] = range;
  item.bytes = Buffer.from(JSON.stringify(metadata, null, 2) + '\n');
  await installPair(f, build(list), receipt => reflectFiles(receipt, list));
  const receipt = await verifyPluginArchive(f.packed.archivePath);
  assert.equal(receipt.pluginId, 'verify-example');
  assert.equal(JSON.parse(item.bytes).peerDependencies['@altifigence/dds-plugin-sdk'], range);
});

test('an independently pinned digest rejects a replaced but otherwise valid release', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'plugin.mjs'), 'throw new Error("Different valid release bytes");');
  const replacement = await packPlugin(f.root, {out: path.join(f.root, 'replacement')});
  assert.equal((await verifyPluginArchive(replacement.archivePath)).checksumPinned, false);
  await assert.rejects(verifyPluginArchive(replacement.archivePath, {expectedSha256: f.packed.artifact.sha256}), /expectedSha256/);
  const renamed = path.join(f.root, 'download.tgz');
  await writeFile(renamed, f.archive);
  assert.equal((await verifyPluginArchive(renamed, {metadataPath: f.packed.metadataPath, expectedSha256: f.packed.artifact.sha256})).checksumPinned, true);
});

test('outer and per-file checksums, disclosure identity and release identity are checked', async t => {
  const f = await fixture(t);
  const changed = entries(f.archive);
  changed.find(entry => name(entry) === 'plugin.mjs').bytes[0] ^= 1;
  const archive = build(changed);
  await writeFile(f.packed.archivePath, archive);
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /release metadata/);
  await installPair(f, archive);
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /file inventory/);
  for (const mutate of [m => {m.artifact.filename = 'wrong.tgz';}, m => {m.pluginVersion = '9.9.9';}, m => {m.disclosureSha256 = 'a'.repeat(64);}, m => {m.files[0].sha256 = 'b'.repeat(64);}, m => {m.files[0].extra = true;}]) {
    await installPair(f, f.archive, mutate);
    await assert.rejects(verifyPluginArchive(f.packed.archivePath));
  }
  const disclosure = entries(f.archive);
  const item = disclosure.find(entry => name(entry) === 'disclosure.json');
  const value = JSON.parse(item.bytes); value.pluginVersion = '2.0.0';
  item.bytes = Buffer.from(JSON.stringify(value));
  await installPair(f, build(disclosure), m => reflectFiles(m, disclosure));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /disclosure identity/);
});

test('recomputed metadata cannot authorize extra/missing archive files or npm execution hooks', async t => {
  const f = await fixture(t);
  const extra = entries(f.archive);
  const added = {header: Buffer.from(extra[0].header), bytes: Buffer.from('unexpected')};
  setName(added, 'package/unlisted.mjs'); extra.push(added);
  await installPair(f, build(extra), m => reflectFiles(m, extra));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /allowlist/);
  const missing = entries(f.archive).filter(entry => name(entry) !== 'LICENSE');
  await installPair(f, build(missing), m => reflectFiles(m, missing));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /allowlist/);
  for (const additions of [{scripts: {postinstall: 'node plugin.mjs'}}, {dependencies: {unexpected: '1.0.0'}}, {peerDependencies: {'@altifigence/dds-plugin-sdk': '*'}}]) {
    const list = entries(f.archive);
    const item = list.find(entry => name(entry) === 'package.json');
    item.bytes = Buffer.from(JSON.stringify({...JSON.parse(item.bytes), ...additions}, null, 2) + '\n');
    await installPair(f, build(list), m => reflectFiles(m, list));
    await assert.rejects(verifyPluginArchive(f.packed.archivePath), /generated SDK metadata/);
  }
});

test('archive paths, links, special entries, duplicate names and header checksums are rejected', async t => {
  const f = await fixture(t);
  for (const filename of ['package/COM\u00b9', 'package/LPT\u00b2.txt', 'package/CONIN$', 'package/CONOUT$', 'package/.git-credentials', 'package/_netrc', 'package/id_ecdsa_sk']) {
    const list = entries(f.archive); setName(list[0], filename);
    await installPair(f, build(list));
    await assert.rejects(verifyPluginArchive(f.packed.archivePath), /unsafe file path|private configuration or key material/);
  }
  for (const filename of ['../outside', 'package/../outside', 'package/C:stream', 'package/.env', 'package/CON', 'other/file']) {
    const list = entries(f.archive); setName(list[0], filename);
    await installPair(f, build(list));
    await assert.rejects(verifyPluginArchive(f.packed.archivePath));
  }
  for (const type of ['1', '2', '5', 'x', 'L']) {
    const list = entries(f.archive); list[0].header[156] = type.charCodeAt(0);
    await installPair(f, build(list));
    await assert.rejects(verifyPluginArchive(f.packed.archivePath), /header/);
  }
  for (const upper of [false, true]) {
    const list = entries(f.archive);
    const duplicate = {header: Buffer.from(list[0].header), bytes: list[0].bytes};
    if (upper) setName(duplicate, 'package/' + name(duplicate).toLowerCase());
    list.push(duplicate);
    await installPair(f, build(list));
    await assert.rejects(verifyPluginArchive(f.packed.archivePath), /duplicate/);
  }
  const broken = gunzipSync(f.archive); broken[148] ^= 1;
  await installPair(f, gzipSync(broken));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /header/);
});

test('bounded parsing rejects malformed gzip, extra members, nonzero padding and tar trailers', async t => {
  const f = await fixture(t);
  const damaged = Buffer.from(f.archive); damaged[damaged.length - 8] ^= 1;
  const tar = gunzipSync(f.archive);
  const firstSize = Number.parseInt(tar.subarray(124, 136).toString('ascii'), 8);
  const padding = Buffer.from(tar); padding[512 + firstSize] = 1;
  for (const archive of [damaged, f.archive.subarray(0, -1), Buffer.concat([f.archive, Buffer.from('junk')]), Buffer.concat([f.archive, gzipSync(Buffer.alloc(0))]), gzipSync(padding), gzipSync(tar.subarray(0, -512)), gzipSync(Buffer.concat([tar, Buffer.alloc(512)]))]) {
    await installPair(f, archive);
    await assert.rejects(verifyPluginArchive(f.packed.archivePath));
  }
  await installPair(f, gzipSync(Buffer.alloc(11 * 1024 * 1024)));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /oversized gzip/);
});

test('file, aggregate, entry-count, compressed input and metadata limits apply before extraction', async t => {
  const f = await fixture(t);
  const oversized = entries(f.archive);
  oversized[0].bytes = Buffer.alloc(4 * 1024 * 1024 + 1);
  await installPair(f, build(oversized));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /byte limit/);
  const aggregate = entries(f.archive);
  for (let index = 0; index < 3; index++) aggregate[index].bytes = Buffer.alloc(index < 2 ? 4 * 1024 * 1024 : 2 * 1024 * 1024 + 1);
  await installPair(f, build(aggregate));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /byte limit/);
  const many = Array.from({length: 257}, (_, index) => {
    const entry = {header: Buffer.from(entries(f.archive)[0].header), bytes: Buffer.alloc(0)};
    setName(entry, `package/file-${index}`); return entry;
  });
  await installPair(f, build(many));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /too many/);
  await writeFile(f.packed.archivePath, Buffer.alloc(12 * 1024 * 1024 + 1));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /byte limit/);
  await installPair(f, f.archive);
  await writeFile(f.packed.metadataPath, ' '.repeat(256 * 1024 + 1));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /byte limit/);
});

test('private content and conflicting portable paths remain rejected with fresh outer checksums', async t => {
  const f = await fixture(t);
  const list = entries(f.archive);
  const secret = ['gh', 'p_', 'a'.repeat(36)].join('');
  list.find(entry => name(entry) === 'plugin.mjs').bytes = Buffer.from(`export const key = '${secret}';`);
  await installPair(f, build(list), m => reflectFiles(m, list));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), error => /credential/.test(error.message) && !error.message.includes(secret));
  await writeFile(path.join(f.root, 'dds-package.json'), JSON.stringify({...f.config, files: [...f.config.files, 'folder', 'FOLDER/child.txt']}));
  await assert.rejects(validatePluginPackage(f.root), /paths conflict/);
});

test('linked local inputs and invalid options are rejected', async t => {
  const f = await fixture(t);
  await link(f.packed.archivePath, path.join(f.root, 'alias.tgz'));
  await assert.rejects(verifyPluginArchive(f.packed.archivePath), /linked/);
  for (const options of [{unexpected: true}, {expectedSha256: 'not-a-digest'}, {metadataPath: ''}]) {
    await assert.rejects(verifyPluginArchive(f.packed.archivePath, options));
  }
});

test('installed-style CLI verifies explicit metadata and hash and rejects ambiguous flags', async t => {
  const f = await fixture(t);
  const run = args => spawnSync(process.execPath, [fileURLToPath(cli), 'verify', f.packed.archivePath, ...args], {encoding: 'utf8', timeout: 10000, windowsHide: true});
  const success = run(['--metadata', f.packed.metadataPath, '--sha256', f.packed.artifact.sha256]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).checksumPinned, true);
  for (const flags of [['--sha256'], ['--unknown', 'value'], ['--sha256', 'a'.repeat(64), '--sha256', 'b'.repeat(64)], ['--sha256', 'c'.repeat(64)]]) {
    const failure = run(flags); assert.equal(failure.status, 1); assert.equal(failure.stdout, '');
  }
});
