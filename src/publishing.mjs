import {SDK_PLUGIN_PEER_RANGE} from './version.mjs';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync, inflateRawSync } from 'node:zlib';
import { parseManifest } from './index.mjs';
import { containsKnownCredential } from './publication-policy.mjs';
import { isPrivateFileComponent, WINDOWS_DEVICE_COMPONENT } from './patterns.mjs';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_PACKAGE = 10 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_TAR = MAX_PACKAGE + MAX_FILES * 1024 + 1024;
const MAX_ARCHIVE = 12 * 1024 * 1024;
const MAX_RELEASE_METADATA = 256 * 1024;
const utf8 = new TextDecoder('utf-8', {fatal: true});
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(message) { throw new Error(`Plugin package: ${message}`); }
function record(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected an object');
  if (Object.keys(value).some(key => ![...required, ...optional].includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('unexpected or missing fields');
}
function text(value, label, limit = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /\u0000/.test(value)) fail(`invalid ${label}`);
  if (/\{[^{}]+\}|<[^>]+>|\b(?:TODO|REPLACE_ME)\b/.test(value)) fail(`resolve ${label} placeholders`);
  return value;
}
function filePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || !value.isWellFormed() || value.includes('\\') || /[\u0000-\u001f\u007f:*?"<>|]/.test(value) || path.posix.isAbsolute(value)) fail('expected a relative portable file path');
  const parts = value.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || WINDOWS_DEVICE_COMPONENT.test(part)) fail('unsafe file path');
    if (isPrivateFileComponent(part) || /^node_modules$/i.test(part)) fail('private configuration or key material cannot be packaged');
  }
  return value;
}
function archiveParts(filename) {
  let name = `package/${filename}`;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const index = name.lastIndexOf('/');
    prefix = name.slice(0, index); name = name.slice(index + 1);
  }
  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) fail('file name exceeds portable archive limits');
  return {name, prefix};
}
function releaseName(manifest) {
  const filename = `${manifest.publisher}-${manifest.id}-${manifest.version}.tgz`;
  if (Buffer.byteLength(filename) > 240) fail('publisher, plugin ID and version exceed the portable release filename limit');
  return filename;
}
function webUrl(value, label, originOnly = false) {
  text(value, label, 2048);
  let url;
  try { url = new URL(value); } catch { fail(`invalid ${label}`); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (!(url.protocol === 'https:' || originOnly && url.protocol === 'http:' && loopback) || url.username || url.password || url.search || url.hash || originOnly && url.pathname !== '/') fail(`invalid ${label}`);
  return originOnly ? url.origin : url.href;
}
function disclosure(value, manifest) {
  record(value, ['schemaVersion', 'publisher', 'pluginId', 'pluginVersion', 'license', 'sourceVisibility', 'supportUrl', 'dataUse', 'backends'], ['privacyNoticeUrl']);
  if (value.schemaVersion !== 1 || value.publisher !== manifest.publisher || value.pluginId !== manifest.id || value.pluginVersion !== manifest.version || value.license !== manifest.license) fail('disclosure identity must match the manifest');
  if (!['open', 'closed'].includes(value.sourceVisibility) || manifest.manifestVersion === 2 && value.sourceVisibility !== manifest.source.visibility) fail('disclosure source visibility must match the manifest');
  webUrl(value.supportUrl, 'supportUrl');
  if (value.privacyNoticeUrl !== undefined) webUrl(value.privacyNoticeUrl, 'privacyNoticeUrl');
  text(value.dataUse, 'dataUse');
  if (!Array.isArray(value.backends) || value.backends.length > 16) fail('backends must be an array of at most 16 disclosures');
  const ids = new Set();
  for (const backend of value.backends) {
    record(backend, ['id', 'operator', 'origin', 'purpose', 'dataCategories', 'retention'], ['privacyNoticeUrl']);
    text(backend.id, 'backend ID', 128);
    if (!/^[a-z][a-z0-9._-]*$/.test(backend.id) || ids.has(backend.id)) fail('backend IDs must be unique identifiers');
    ids.add(backend.id);
    text(backend.operator, 'backend operator', 256);
    webUrl(backend.origin, 'backend origin', true);
    text(backend.purpose, 'backend purpose');
    text(backend.retention, 'backend retention');
    if (!Array.isArray(backend.dataCategories) || backend.dataCategories.length > 32) fail('invalid data categories');
    backend.dataCategories.forEach(category => text(category, 'data category', 256));
    if (backend.privacyNoticeUrl !== undefined) webUrl(backend.privacyNoticeUrl, 'backend privacyNoticeUrl');
  }
  return value;
}
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function readRegular(root, relative, limit = MAX_FILE) {
  const parts = filePath(relative).split('/');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || index < parts.length - 1 && !info.isDirectory() || index === parts.length - 1 && !info.isFile()) fail('only regular files and directories are supported');
    if (!isInside(root, await realpath(current))) fail('file escaped the package root');
  }
  const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink > 1 || before.size > limit) fail('file is linked or exceeds its byte limit');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const {bytesRead} = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(current);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || named.isSymbolicLink() || named.ino !== before.ino || !isInside(root, await realpath(current))) fail('file changed while packaging');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
function json(bytes, label) {
  try { return JSON.parse(utf8.decode(bytes)); } catch { fail(`${label} must contain valid UTF-8 JSON`); }
}
function packageFiles(configuration) {
  if (configuration.length > 64 * 1024) fail('package configuration exceeds its byte limit');
  const config = json(configuration, 'dds-package.json');
  record(config, ['schemaVersion', 'files']);
  if (config.schemaVersion !== 1 || !Array.isArray(config.files) || config.files.length < 3 || config.files.length > MAX_FILES - 2) fail('invalid package file allowlist');
  const files = config.files.map(filePath);
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length || files.some(file => ['dds-package.json', 'package.json'].includes(file.toLowerCase()))) fail('duplicate or generated configuration entry');
  if (!files.includes('plugin.json') || !files.includes('disclosure.json')) fail('include plugin.json and disclosure.json in the file allowlist');
  const names = new Set([...files, 'dds-package.json', 'package.json'].map(file => file.toLowerCase()));
  for (const name of names) {
    const parts = name.split('/');
    for (let count = 1; count < parts.length; count++) if (names.has(parts.slice(0, count).join('/'))) fail('file and directory paths conflict');
  }
  return files;
}
function inspectContents(contents, archived = false) {
  const configuration = contents.get('dds-package.json');
  if (!configuration) fail('include dds-package.json');
  const files = packageFiles(configuration);
  const expected = [...files, 'dds-package.json', ...(archived ? ['package.json'] : [])];
  if (contents.size !== expected.length || expected.some(file => !contents.has(file))) fail('archive files must match the explicit allowlist');
  let size = 0;
  for (const [file, bytes] of contents) {
    archiveParts(filePath(file));
    if (bytes.length > MAX_FILE) fail('file exceeds its byte limit');
    if (containsKnownCredential(bytes)) fail('recognizable credential material cannot be packaged');
    if ((size += bytes.length) > MAX_PACKAGE) fail('package exceeds the 10 MiB uncompressed limit');
  }
  const manifestBytes = contents.get('plugin.json');
  const manifest = parseManifest(utf8.decode(manifestBytes));
  releaseName(manifest);
  const entry = manifest.entry.replace(/^\.\//, '');
  const licenseFile = manifest.manifestVersion === 2 ? manifest.source.licenseFile.replace(/^\.\//, '') : 'LICENSE';
  if (!contents.has(filePath(entry)) || !contents.has(filePath(licenseFile))) fail('include the entry module and license file in the allowlist');
  if (!utf8.decode(contents.get(licenseFile)).trim()) fail('license file is empty');
  const disclosed = disclosure(json(contents.get('disclosure.json'), 'disclosure.json'), manifest);
  const packageName = `@${manifest.publisher}/${manifest.id}`;
  if (packageName.length > 214) fail('publisher and plugin IDs exceed the npm package name limit');
  const metadata = {
    name: packageName, version: manifest.version, type: 'module',
    description: manifest.name, main: `./${entry}`, exports: `./${entry}`,
    license: manifest.license.includes('LicenseRef-') ? `SEE LICENSE IN ${licenseFile}` : manifest.license,
    peerDependencies: {'@altifigence/dds-plugin-sdk': SDK_PLUGIN_PEER_RANGE},
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  if (archived) {
    // Only the generated inert npm metadata is accepted, including the tested
    // SDK line. Additional scripts or dependencies cannot be smuggled into it.
    const accepted = [metadataBytes, ...['>=0.3.0 <0.4.0', '>=0.4.0 <0.5.0', '>=0.5.0 <0.6.0', '>=0.6.0 <0.7.0', '>=0.7.0 <0.8.0', '>=0.8.0 <0.9.0', '>=0.9.0 <0.10.0', '>=0.10.0 <0.11.0', '>=0.11.0 <0.12.0', '>=0.12.0 <0.13.0', '>=0.13.0 <0.14.0', '1.0.0-rc.1'].map(range => Buffer.from(`${JSON.stringify({...metadata, peerDependencies: {'@altifigence/dds-plugin-sdk': range}}, null, 2)}\n`))];
    if (!accepted.some(bytes => contents.get('package.json').equals(bytes))) fail('package.json must match the generated SDK metadata');
  } else {
    contents.set('package.json', metadataBytes);
    size += metadataBytes.length;
  }
  if (size > MAX_PACKAGE) fail('package exceeds the 10 MiB uncompressed limit');
  for (const filename of contents.keys()) archiveParts(filename);
  const inventory = [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => Object.freeze({path: name, size: bytes.length, sha256: sha256(bytes)}));
  const report = Object.freeze({schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, publisher: manifest.publisher, license: manifest.license, sourceVisibility: disclosed.sourceVisibility, manifestSha256: sha256(manifestBytes), disclosureSha256: sha256(contents.get('disclosure.json')), unpackedSize: size, files: Object.freeze(inventory)});
  return {manifest, contents, report};
}
async function inspect(directory) {
  const requested = path.resolve(directory);
  if (!(await lstat(requested)).isDirectory()) fail('package root must be a real directory');
  const root = await realpath(requested);
  const configuration = await readRegular(root, 'dds-package.json', 64 * 1024);
  const files = packageFiles(configuration);
  const contents = new Map([['dds-package.json', configuration]]);
  let size = configuration.length;
  for (const file of [...files].sort()) {
    const bytes = await readRegular(root, file);
    if ((size += bytes.length) > MAX_PACKAGE) fail('package exceeds the 10 MiB uncompressed limit');
    contents.set(file, bytes);
  }
  return inspectContents(contents);
}

/** Inspect an explicit file allowlist without importing code or running scripts. */
export async function validatePluginPackage(directory) { return (await inspect(directory)).report; }

function tarHeader(filename, size) {
  const header = Buffer.alloc(512);
  const {name, prefix} = archiveParts(filename);
  header.write(name, 0, 100, 'utf8');
  const octal = (value, offset, length) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

/** Create a deterministic tar.gz and separate hash inventory. Never uploads. */
export async function packPlugin(directory, options) {
  if (!options || typeof options.out !== 'string' || !options.out.trim() || Object.keys(options).some(key => key !== 'out')) fail('supply an output directory');
  const {manifest, contents, report} = await inspect(directory);
  const chunks = [];
  for (const file of report.files) {
    const bytes = contents.get(file.path);
    chunks.push(tarHeader(file.path, bytes.length), bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(chunks), {level: 9});
  const filename = releaseName(manifest);
  const outputDirectory = path.resolve(options.out);
  await mkdir(outputDirectory, {recursive: true});
  if ((await lstat(outputDirectory)).isSymbolicLink()) fail('output directory must not be a link');
  const outputRoot = await realpath(outputDirectory);
  const archivePath = path.join(outputRoot, filename);
  const metadataPath = path.join(outputRoot, `${filename}.release.json`);
  const metadata = {...report, artifact: {filename, size: archive.length, sha256: sha256(archive)}};
  // wx prevents accidental replacement of a published version. Remove only our
  // new archive when the paired metadata cannot be created.
  await writeFile(archivePath, archive, {flag: 'wx'});
  try { await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {flag: 'wx'}); }
  catch (error) { await unlink(archivePath); throw error; }
  return Object.freeze({...metadata, archivePath, metadataPath});
}

function archiveContents(archive) {
  // DDS pack emits a single gzip member with a fixed ten-byte header. Reject
  // optional names/comments, concatenated members and trailing input. Both
  // decompression calls are bounded: gunzip checks the CRC/size trailer, and
  // inflateRaw exposes the exact compressed-stream length on Node 22 and 24.
  if (archive.length < 18 || archive[0] !== 31 || archive[1] !== 139 || archive[2] !== 8 || archive[3] !== 0) fail('expected a DDS gzip archive');
  let tar;
  try {
    tar = gunzipSync(archive, {maxOutputLength: MAX_TAR});
    const raw = inflateRawSync(archive.subarray(10), {info: true, maxOutputLength: MAX_TAR});
    if (10 + raw.engine.bytesWritten + 8 !== archive.length) fail('gzip contains additional members or trailing input');
  } catch { fail('invalid or oversized gzip archive'); }
  if (tar.length % 512 || tar.length < 1024) fail('invalid tar length');
  const contents = new Map();
  const names = new Set();
  let cursor = 0;
  let total = 0;
  while (cursor < tar.length - 1024) {
    const header = tar.subarray(cursor, cursor + 512);
    const field = (offset, length) => {
      const bytes = header.subarray(offset, offset + length);
      const end = bytes.indexOf(0);
      try { return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end)); }
      catch { fail('invalid UTF-8 archive path'); }
    };
    const fullName = [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    if (!fullName.startsWith('package/')) fail('archive entry must be under package/');
    const filename = filePath(fullName.slice(8));
    const encodedSize = header.subarray(124, 136).toString('ascii');
    if (!/^[0-7]{11}\x00$/.test(encodedSize)) fail('invalid archive file size');
    const size = Number.parseInt(encodedSize, 8);
    if (size > MAX_FILE || (total += size) > MAX_PACKAGE) fail('archive exceeds its byte limit');
    // Comparing with the complete supported header checks its checksum, mode,
    // regular-file type, owner, link fields, path encoding and reserved bytes.
    if (!header.equals(tarHeader(filename, size))) fail('unsupported or invalid archive header');
    if (names.has(filename.toLowerCase())) fail('duplicate archive entry');
    if (contents.size >= MAX_FILES) fail('too many archive entries');
    const start = cursor + 512;
    const end = start + size;
    const next = start + Math.ceil(size / 512) * 512;
    if (next > tar.length - 1024 || tar.subarray(end, next).some(byte => byte !== 0)) fail('invalid archive padding or length');
    names.add(filename.toLowerCase());
    contents.set(filename, tar.subarray(start, end));
    cursor = next;
  }
  if (cursor !== tar.length - 1024 || tar.subarray(cursor).some(byte => byte !== 0)) fail('archive must end with exactly two empty blocks');
  return contents;
}

async function readInputFile(filename, limit) {
  if (typeof filename !== 'string' || !filename.trim()) fail('supply a local file path');
  const resolved = path.resolve(filename);
  const root = await realpath(path.dirname(resolved));
  return readRegular(root, path.basename(resolved), limit);
}

/** Verify downloaded bytes without extracting, importing or executing a plugin. */
export async function verifyPluginArchive(archivePath, options = {}) {
  record(options, [], ['metadataPath', 'expectedSha256']);
  if (options.metadataPath !== undefined && (typeof options.metadataPath !== 'string' || !options.metadataPath.trim())) fail('supply a metadata file path');
  if (options.expectedSha256 !== undefined && (typeof options.expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedSha256))) fail('expectedSha256 must be 64 lowercase hexadecimal characters');
  const archive = await readInputFile(archivePath, MAX_ARCHIVE);
  const digest = sha256(archive);
  if (options.expectedSha256 !== undefined && digest !== options.expectedSha256) fail('archive does not match expectedSha256');
  const metadataPath = options.metadataPath ?? `${archivePath}.release.json`;
  const metadata = json(await readInputFile(metadataPath, MAX_RELEASE_METADATA), 'release metadata');
  return inspectPluginArchiveBytes(archive, metadata, {expectedSha256: options.expectedSha256}).receipt;
}

/** Inspect a bounded in-memory snapshot with the same verifier as local archives. */
export function inspectPluginArchiveBytes(input, metadata, options = {}) {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_ARCHIVE) fail('invalid or oversized archive bytes');
  record(options, [], ['expectedSha256']);
  const archive = Buffer.from(input);
  const digest = sha256(archive);
  if (options.expectedSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(options.expectedSha256) || digest !== options.expectedSha256)) fail('archive does not match expectedSha256');
  if (JSON.stringify(metadata)?.length > MAX_RELEASE_METADATA) fail('oversized release metadata');
  const fields = ['schemaVersion', 'pluginId', 'pluginVersion', 'publisher', 'license', 'sourceVisibility', 'manifestSha256', 'disclosureSha256', 'unpackedSize', 'files', 'artifact'];
  record(metadata, fields);
  record(metadata.artifact, ['filename', 'size', 'sha256']);
  if (metadata.artifact.size !== archive.length || metadata.artifact.sha256 !== digest) fail('archive does not match release metadata');
  const {manifest, report, contents} = inspectContents(archiveContents(archive), true);
  if (metadata.artifact.filename !== releaseName(manifest)) fail('release filename does not match plugin identity');
  for (const field of fields.filter(field => field !== 'files' && field !== 'artifact')) if (metadata[field] !== report[field]) fail('release metadata does not match packaged content');
  if (!Array.isArray(metadata.files) || metadata.files.length !== report.files.length) fail('release file inventory does not match archive');
  for (let index = 0; index < report.files.length; index++) {
    const claimed = metadata.files[index];
    record(claimed, ['path', 'size', 'sha256']);
    if (['path', 'size', 'sha256'].some(field => claimed[field] !== report.files[index][field])) fail('release file inventory does not match archive');
  }
  const artifact = Object.freeze({filename: releaseName(manifest), size: archive.length, sha256: digest});
  // This receipt describes the bytes read now, not a mutable path's future
  // contents, a trusted publisher, an installation or a malware assessment.
  const receipt = Object.freeze({...report, artifact, checksumPinned: options.expectedSha256 !== undefined});
  return Object.freeze({receipt, manifest, files: Object.freeze([...contents].map(([path, data]) => Object.freeze({path, data: Uint8Array.from(data)})))});
}
