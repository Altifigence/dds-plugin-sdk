import * as fs from 'node:fs/promises';
import {watchFile, unwatchFile} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {parseManifest, parseJsonValue} from './index.mjs';
import {validatePluginPackage} from './publishing.mjs';
import {JOB_LIMITS} from './jobs.mjs';

const sdk = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const error = message => new Error(message);
const nodeSupported = version => /^(?:22|24)\./.test(version);
const plainOptions = (options, allowed) => {
  if (!options || typeof options !== 'object' || Array.isArray(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw error('Invalid development options');
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!allowed.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) throw error('Invalid development options');
  }
};
async function readJson(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65_536) throw error('Expected a small regular configuration file');
  const contents = await fs.readFile(file, 'utf8');
  if (Buffer.byteLength(contents) > 65_536) throw error('Configuration exceeds 64 KiB');
  return JSON.parse(contents);
}

/** Creates only a new directory; never installs dependencies or executes plugin code. */
export async function initPlugin(directory, options = {}) {
  plainOptions(options, ['id', 'publisher', 'name']);
  if (typeof directory !== 'string' || !directory) throw error('Provide a new plugin directory');
  const target = path.resolve(directory);
  const manifest = parseManifest({manifestVersion: 2, id: options.id ?? path.basename(target), publisher: options.publisher ?? 'example', name: options.name ?? 'My DDS Plugin', version: '0.1.0', protocolVersion: 1, entry: './plugin.mjs', runtime: 'workspace', capabilities: ['commands'], permissions: [], supportedHosts: ['test-host', 'workspace-host'], license: 'Apache-2.0', source: {visibility: 'open', licenseFile: 'LICENSE'}});
  if (`@${manifest.publisher}/${manifest.id}`.length > 214) throw error('Publisher and plugin ID exceed the package name limit');
  // Prepare and validate all contents before claiming the destination.
  const files = new Map([
    ['plugin.json', json(manifest)],
    ['plugin.mjs', `import {definePlugin} from '@altifigence/dds-plugin-sdk';\nimport manifest from './plugin.json' with {type: 'json'};\n\nexport default definePlugin(manifest, context => context.registerCommand({\n  id: 'greet', title: 'Say hello',\n  parameters: [{name: 'name', label: 'Your name', type: 'string', required: true}],\n}, (input, {signal, job}) => {\n  signal.throwIfAborted();\n  job?.reportProgress({completed: 1, total: 1, message: 'Greeting ready'});\n  job?.log('info', 'Greeting command completed');\n  return {message: 'Hello, ' + input.name + '!', pluginId: context.pluginId};\n}));\n`],
    ['plugin.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {createPluginHost} from '@altifigence/dds-plugin-sdk';\nimport plugin from './plugin.mjs';\n\ntest('greet returns the supplied name', async t => {\n  const host = createPluginHost();\n  t.after(() => host.dispose());\n  await host.activate(plugin);\n  assert.deepEqual(await host.executeCommand(plugin.manifest.id, 'greet', {name: 'Developer'}), {message: 'Hello, Developer!', pluginId: plugin.manifest.id});\n  await assert.rejects(host.executeCommand(plugin.manifest.id, 'greet', {}), {code: 'invalid_contract'});\n});\n`],
    ['dds-package.json', json({schemaVersion: 1, files: ['plugin.json', 'plugin.mjs', 'disclosure.json', 'LICENSE', 'NOTICE']})],
    ['disclosure.json', json({schemaVersion: 1, publisher: manifest.publisher, pluginId: manifest.id, pluginVersion: manifest.version, license: manifest.license, sourceVisibility: 'open', supportUrl: 'https://example.com/support', dataUse: 'The greet command uses the supplied name to return a greeting. It does not read workspace files, use external backends, or store input.', backends: []})],
    ['package.json', json({name: `@${manifest.publisher}/${manifest.id}`, version: manifest.version, private: true, type: 'module', scripts: {test: 'node --test plugin.test.mjs', doctor: 'dds-plugin doctor .', dev: 'dds-plugin dev . --trust-local-code --watch', 'validate:plugin': 'dds-plugin validate .', 'pack:plugin': 'dds-plugin pack . --out dist'}, dependencies: {'@altifigence/dds-plugin-sdk': `https://github.com/Altifigence/dds-plugin-sdk/releases/download/v${sdk.version}/altifigence-dds-plugin-sdk-${sdk.version}.tgz`}})],
    ['.gitignore', 'node_modules/\ndist/\n'],
    ['README.md', `# ${manifest.name}\n\nInstall the pinned SDK with \`npm install --ignore-scripts\`, then run \`npm run doctor\`.\n\nRun trusted local code with:\n\n\`\`\`sh\nnpx --no-install dds-plugin dev . --trust-local-code --command greet --input '{"name":"World"}'\nnpx --no-install dds-plugin dev . --trust-local-code --job --command greet --input '{"name":"World"}'\nnpm run dev\n\`\`\`\n\nThe dev host has no workspace or backend grants. Watch mode restarts a child process after a declared package file changes; Ctrl+C stops it. This is trusted local execution, not a security sandbox.\n\nBefore distribution, replace example publisher/support metadata, review the Apache-2.0 license and NOTICE inherited from this scaffold, and update disclosure.json for any behavior changes. Add each distributable file to dds-package.json.\n\nRun \`npm run pack:plugin\` to build a release archive. The development package.json is private; the pack command generates inert consumer metadata without install scripts.\n`],
    ['LICENSE', await fs.readFile(new URL('../LICENSE', import.meta.url), 'utf8')],
    ['NOTICE', await fs.readFile(new URL('../NOTICE', import.meta.url), 'utf8')],
  ]);
  const parent = await fs.lstat(path.dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw error('Destination parent must be a real existing directory');
  try {await fs.mkdir(target);} catch (failure) {if (failure.code === 'EEXIST') throw error('Destination already exists; choose a new directory'); throw failure;}
  for (const [name, text] of files) await fs.writeFile(path.join(target, name), text, {flag: 'wx'});
  return Object.freeze({directory: target, pluginId: manifest.id, sdkVersion: sdk.version, files: Object.freeze([...files.keys()]), next: ['npm install --ignore-scripts', 'npm run doctor', 'npm run dev']});
}

/** Reads metadata only. No import, install, npm script, or plugin entry execution. */
export async function doctorPlugin(directory) {
  if (typeof directory !== 'string' || !directory) throw error('Provide a plugin directory');
  const root = path.resolve(directory), checks = [];
  const check = (id, status, message, fix) => checks.push(Object.freeze({id, status, message, ...(fix ? {fix} : {})}));
  check('node', nodeSupported(process.versions.node) ? 'pass' : 'error', `Node ${process.versions.node}`, 'Use Node 22 or 24.');
  try {
    const report = await validatePluginPackage(root);
    check('package', 'pass', `${report.pluginId}: manifest, disclosure, license and allowlisted files are valid.`);
    const manifest = await readJson(path.join(root, 'plugin.json'));
    const disclosure = await readJson(path.join(root, 'disclosure.json'));
    if (manifest.publisher === 'example' || new URL(disclosure.supportUrl).hostname === 'example.com') check('publisher', 'warning', 'Example publisher or support metadata is still present.', 'Set your publisher and support URL before distribution.');
    else check('publisher', 'pass', 'Publisher and support metadata are customized.');
  } catch (failure) {check('package', 'error', failure instanceof Error ? failure.message.slice(0, 2_048) : 'Package metadata is invalid.', 'Correct plugin.json, disclosure.json and dds-package.json; do not add private files.');}
  try {
    const packagePath = createRequire(path.join(root, 'package.json')).resolve('@altifigence/dds-plugin-sdk/package.json');
    const installed = await readJson(packagePath);
    if (installed.name !== sdk.name || !/^0\.6\.\d+(?:$|-)/.test(installed.version)) throw error('Install SDK 0.6.x for these development tools.');
    check('sdk', 'pass', `SDK ${installed.version} resolves from this project.`);
  } catch {check('sdk', 'error', 'SDK 0.6.x is not installed for this project.', 'Run npm install --ignore-scripts using the pinned SDK archive in package.json.');}
  return Object.freeze({ok: checks.every(item => item.status !== 'error'), directory: root, checks: Object.freeze(checks)});
}

const stoppingTrees = new WeakMap();
function stopTree(child) {
  if (!child.pid) return Promise.resolve();
  if (stoppingTrees.has(child)) return stoppingTrees.get(child);
  const stopping = (async () => {
    const exited = child.exitCode !== null || child.signalCode !== null;
    let timer;
    const exit = exited ? Promise.resolve() : new Promise((resolve, reject) => {
      child.once('exit', resolve);
      timer = setTimeout(() => reject(error('Could not stop the development child process')), 5_000);
    });
    exit.catch(() => {});
    try {
      if (process.platform === 'win32' && !exited) {
        const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        await new Promise(resolve => {
          const killer = spawn(executable, ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore', shell: false});
          const timeout = setTimeout(() => {killer.kill(); resolve();}, 4_000);
          const done = () => {clearTimeout(timeout); resolve();}; killer.once('error', done); killer.once('exit', done);
        });
      } else if (process.platform !== 'win32') {
        // A group may still contain children after its leader has exited.
        try {process.kill(-child.pid, 'SIGKILL');} catch { /* group already exited */ }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exit;
    } finally {clearTimeout(timer);}
  })();
  stoppingTrees.set(child, stopping); return stopping;
}

/** Runs explicitly trusted plugin code in a replaceable child; not an OS sandbox. */
export async function runPluginDev(directory, options = {}) {
  plainOptions(options, ['trustLocalCode', 'watch', 'command', 'input', 'job', 'timeoutMs', 'signal', 'onEvent']);
  if (options.trustLocalCode !== true) throw error('dev executes local plugin code; pass --trust-local-code for a plugin you trust.');
  for (const key of ['watch', 'job']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw error(`Invalid ${key} option`);
  const {watch = false, command, job = false, timeoutMs = 30_000, signal, onEvent = () => {}} = options;
  const input = parseJsonValue(options.input ?? {});
  if (command !== undefined && (typeof command !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(command))) throw error('Invalid command ID');
  if (job && !command) throw error('--job requires --command');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > (job ? JOB_LIMITS.maxTimeoutMs : 30_000)) throw error('Invalid dev timeout');
  if (signal !== undefined && !(signal instanceof AbortSignal) || typeof onEvent !== 'function') throw error('Invalid development callback or signal');
  if (signal?.aborted) return Object.freeze({ok: true, runs: 0, stopped: true});
  const root = path.resolve(directory), report = await doctorPlugin(root);
  if (!report.ok) throw error('Development checks failed; run dds-plugin doctor first.');
  const watched = new Map(); let child, stopping = false, changing = false, debounce, deadline, runs = 0, lastOk = true, resolveDone, rejectDone, tail = Promise.resolve();
  const done = new Promise((resolve, reject) => {resolveDone = resolve; rejectDone = reject;});
  const emit = value => onEvent(Object.freeze(value));
  const finish = async failure => {
    if (stopping) return; stopping = true; clearTimeout(debounce); clearTimeout(deadline);
    for (const [file, listener] of watched) unwatchFile(file, listener); watched.clear(); signal?.removeEventListener('abort', onAbort);
    try {await stopTree(child ?? {});} catch (cleanupFailure) {failure ??= cleanupFailure;}
    if (failure) rejectDone(failure); else resolveDone(Object.freeze({ok: lastOk, runs, stopped: !!signal?.aborted}));
  };
  const enqueue = () => {
    if (stopping) return; clearTimeout(debounce);
    debounce = setTimeout(() => {tail = tail.then(restart).catch(finish);}, 150);
  };
  const refreshWatches = async () => {
    if (!watch) return;
    const verified = await validatePluginPackage(root);
    const names = verified.files.map(file => file.path).filter(file => file !== 'package.json');
    if (names.length > 257) throw error('Watch file limit exceeded');
    const wanted = new Set(names.map(name => path.join(root, name)));
    for (const [file, listener] of watched) if (!wanted.has(file)) {unwatchFile(file, listener); watched.delete(file);}
    for (const file of wanted) if (!watched.has(file)) {
      const listener = (current, previous) => {if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size || current.ino !== previous.ino) enqueue();};
      watchFile(file, {interval: 250}, listener); watched.set(file, listener);
    }
  };
  const restart = async () => {
    if (stopping) return;
    changing = true; clearTimeout(deadline); await stopTree(child ?? {}); child = undefined;
    if (stopping) return;
    const checked = await doctorPlugin(root);
    if (!checked.ok) {changing = false; lastOk = false; emit({type: 'validation', ok: false, checks: checked.checks}); if (!watch) await finish(); return;}
    await refreshWatches(); if (stopping) return;
    changing = false; runs++;
    const owned = spawn(process.execPath, [fileURLToPath(new URL('./dev-worker.mjs', import.meta.url))], {cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32', windowsHide: true, shell: false, env: {...process.env, NODE_OPTIONS: ''}});
    child = owned; let bytes = 0, completed = false;
    const output = (stream, chunk) => {
      if (child !== owned || stopping) return; bytes += chunk.length;
      if (bytes > 262_144) {void finish(error('Development output exceeded 256 KiB')); return;}
      try {emit({type: 'output', stream, text: chunk.toString('utf8')});} catch (failure) {void finish(failure);}
    };
    owned.stdout.on('data', chunk => output('stdout', chunk)); owned.stderr.on('data', chunk => output('stderr', chunk));
    owned.once('error', failure => {void finish(error(`Development process failed: ${failure.code ?? 'spawn'}`));});
    owned.on('message', message => {
      if (child !== owned || stopping || completed || !message || message.type !== 'complete' || typeof message.ok !== 'boolean') return;
      completed = true; lastOk = message.ok; clearTimeout(deadline);
      tail = tail.then(async () => {if (child !== owned || stopping) return; await stopTree(owned); emit({type: 'complete', run: runs, ok: lastOk}); if (!watch) await finish();}).catch(finish);
    });
    owned.once('exit', () => {
      if (child === owned && !stopping && !changing && !completed) {
        lastOk = false; completed = true; clearTimeout(deadline);
        tail = tail.then(async () => {if(child !== owned || stopping)return; await stopTree(owned); emit({type: 'complete', run: runs, ok: false}); if (!watch) await finish();}).catch(finish);
      }
    });
    deadline = setTimeout(() => {if (child === owned && !stopping) {lastOk = false; completed = true; tail = tail.then(async () => {if(child !== owned || stopping)return; await stopTree(owned); emit({type: 'timeout', run: runs, ok: false}); if (!watch) await finish();}).catch(finish);}}, timeoutMs + 1_000);
    owned.send({directory: root, command, input, job, timeoutMs}, failure => {if (failure && !stopping && !completed) void finish(error('Could not configure the development process'));});
    emit({type: 'start', run: runs, pid: owned.pid});
  };
  const onAbort = () => {void finish();}; signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) void finish(); else tail = tail.then(restart).catch(finish);
  return done;
}
