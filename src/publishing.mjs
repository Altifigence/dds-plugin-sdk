import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, open, mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseManifest } from './index.mjs';
import { containsKnownCredential } from './publication-policy.mjs';

const MAX_FILE = 4 * 1024 * 1024;
const MAX_PACKAGE = 10 * 1024 * 1024;
const MAX_FILES = 256;
const utf8 = new TextDecoder('utf-8', {fatal: true});
const forbidden = /^(?:\.git|\.hg|\.svn|node_modules|\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.aws|\.azure|\.ssh|\.gnupg|\.kube|\.docker|id_rsa|id_ed25519)$/i;
const secretExtension = /\.(?:pem|key|p12|pfx)$/i;
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
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) fail('unsafe file path');
    if (forbidden.test(part) || secretExtension.test(part)) fail('private configuration or key material cannot be packaged');
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
async function inspect(directory) {
  const requested = path.resolve(directory);
  if (!(await lstat(requested)).isDirectory()) fail('package root must be a real directory');
  const root = await realpath(requested);
  const configuration = await readRegular(root, 'dds-package.json', 64 * 1024);
  if (containsKnownCredential(configuration)) fail('recognizable credential material cannot be packaged');
  const config = json(configuration, 'dds-package.json');
  record(config, ['schemaVersion', 'files']);
  if (config.schemaVersion !== 1 || !Array.isArray(config.files) || config.files.length < 3 || config.files.length > MAX_FILES - 2) fail('invalid package file allowlist');
  const files = config.files.map(filePath);
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length || files.some(file => ['dds-package.json', 'package.json'].includes(file.toLowerCase()))) fail('duplicate or generated configuration entry');
  if (!files.includes('plugin.json') || !files.includes('disclosure.json')) fail('include plugin.json and disclosure.json in the file allowlist');
  const contents = new Map([['dds-package.json', configuration]]);
  let size = configuration.length;
  for (const file of [...files].sort()) {
    const bytes = await readRegular(root, file);
    if (containsKnownCredential(bytes)) fail('recognizable credential material cannot be packaged');
    if ((size += bytes.length) > MAX_PACKAGE) fail('package exceeds the 10 MiB uncompressed limit');
    contents.set(file, bytes);
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
    peerDependencies: {'@altifigence/dds-plugin-sdk': '>=0.3.0 <0.4.0'},
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
  contents.set('package.json', metadataBytes);
  size += metadataBytes.length;
  if (size > MAX_PACKAGE) fail('package exceeds the 10 MiB uncompressed limit');
  for (const filename of contents.keys()) archiveParts(filename);
  const inventory = [...contents].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, bytes]) => Object.freeze({path: name, size: bytes.length, sha256: sha256(bytes)}));
  const report = Object.freeze({schemaVersion: 1, pluginId: manifest.id, pluginVersion: manifest.version, publisher: manifest.publisher, license: manifest.license, sourceVisibility: disclosed.sourceVisibility, manifestSha256: sha256(manifestBytes), disclosureSha256: sha256(contents.get('disclosure.json')), unpackedSize: size, files: Object.freeze(inventory)});
  return {manifest, contents, report};
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
