import assert from 'node:assert/strict';
import {readFile, lstat, realpath} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {containsKnownCredential} from '../src/publication-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const policy = JSON.parse(await readFile(path.join(root, 'PUBLIC_SURFACE.json'), 'utf8'));
assert.equal(policy.schemaVersion, 1);
assert.ok(Array.isArray(policy.packageFiles) && policy.packageFiles.length > 0);
assert.equal(new Set(policy.packageFiles).size, policy.packageFiles.length);
function run(command, args) {
  const result = spawnSync(command, args, {cwd:root, encoding:'utf8', maxBuffer:8_000_000, timeout:120_000});
  if (result.error || result.status !== 0) throw new Error('Public surface inspection failed; use a complete Git checkout and npm.');
  return result.stdout;
}
const privateReference = /(?:github\.com[:/]altifigence-internal|@altifigence-internal\/|C:[/\\]alti[/\\]|C:[/\\]Users[/\\]user[/\\])/i;
const prohibitedPath = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.npmrc|\.pypirc|\.netrc|\.aws|\.azure|\.ssh|\.gnupg|\.kube|\.docker|src-tauri|engines|internal)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;
const tracked = run('git', ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
for (const record of tracked) {
  const [entry, name] = record.split('\t');
  assert.ok(['100644', '100755'].includes(entry.split(' ')[0]), `Unexpected Git file mode: ${name}`);
  assert.ok(!prohibitedPath.test(name), `Private file path: ${name}`);
  const bytes = await readFile(path.join(root, name));
  assert.ok(!containsKnownCredential(bytes), `Recognizable credential material: ${name}`);
  assert.ok(!privateReference.test(bytes.toString('utf8')), `Private implementation reference: ${name}`);
}
assert.ok(process.env.npm_execpath, 'Run npm run public:check');
const packed = JSON.parse(run(process.execPath, [process.env.npm_execpath, 'pack', '--json', '--dry-run', '--ignore-scripts']))[0];
const actual = packed.files.map(file => file.path).sort();
assert.deepEqual(actual, [...policy.packageFiles].sort(), 'Review every published file in PUBLIC_SURFACE.json');
const canonicalRoot = await realpath(root);
for (const name of actual) {
  const absolute = path.join(root, name);
  const info = await lstat(absolute);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Not a regular package file: ${name}`);
  const relative = path.relative(canonicalRoot, await realpath(absolute));
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `File outside package root: ${name}`);
  assert.ok(!prohibitedPath.test(name), `Private package path: ${name}`);
  const bytes = await readFile(absolute);
  assert.ok(!containsKnownCredential(bytes) && !privateReference.test(bytes.toString('utf8')), `Private material in package file: ${name}`);
}
console.log(`Public surface: ${tracked.length} tracked files inspected; ${actual.length} explicitly reviewed package files.`);
