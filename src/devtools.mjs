import * as fs from 'node:fs/promises';
import {watchFile, unwatchFile} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {parseManifest, parseJsonValue} from './index.mjs';
import {validatePluginPackage} from './publishing.mjs';
import {JOB_LIMITS} from './jobs.mjs';
import {generatePluginContracts,parseDevelopmentDefinition,DEVTOOLS_LIMITS} from './dev-generation.mjs';
import {readDevFile,destinationExists} from './dev-files.mjs';
import {parseDiagnosticReport} from './diagnostics.mjs';

const sdk = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const sdkLine = sdk.version.split('.').slice(0, 2).join('.');
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

export {initPlugin,planPlugin} from './dev-scaffolds.mjs';
export {generatePluginContracts,parseDevelopmentDefinition,PLUGIN_TEMPLATES,DEVTOOLS_LIMITS} from './dev-generation.mjs';

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
    const parsed=parseManifest(manifest);
    check('manifest','pass',`${parsed.manifestVersion === 1 ? 'ui' : parsed.runtime} plugin; ${parsed.capabilities.length} capabilities, ${parsed.permissions.length} requested permissions.`);
    check('permissions',parsed.permissions.length?'warning':'pass',parsed.permissions.length?`Operator grants are required: ${parsed.permissions.join(', ')}.`:'This plugin requests no host permissions.');
    if(await destinationExists(path.join(root,'dds-dev.json'))){
      const definition=parseDevelopmentDefinition(JSON.parse(await readDevFile(path.join(root,'dds-dev.json'),DEVTOOLS_LIMITS.definitionBytes)),parsed);
      check('development-definition','pass',`${definition.template} template; ${definition.commands.length} declared commands.`);
      const generated=await generatePluginContracts(root,{check:true});
      check('generated',generated.ok?'pass':'error',generated.ok?'Generated runtime metadata, declarations and schemas match the current SDK/source.':'Generated files are missing, modified or out of date.','Review dds-plugin generate . --dry-run. Preserve manual changes before replacing exact generated output.');
      const packaged=new Set(report.files.map(file=>file.path));
      const missing=generated.files.filter(file=>!packaged.has('generated/'+file.path));
      check('generated-package',missing.length?'error':'pass',missing.length?'Generated files are absent from the package allowlist.':'All generated files are included in the package allowlist.','Review generated output and add its files to dds-package.json before distribution.');
      await readDevFile(path.join(root,'LICENSE.sdk'),65_536);await readDevFile(path.join(root,'NOTICE'),65_536);
      check('scaffold-notices','pass','Publisher license and inherited SDK/scaffold notices are present.');
    }
    if (manifest.publisher === 'example' || new URL(disclosure.supportUrl).hostname === 'example.com') check('publisher', 'warning', 'Example publisher or support metadata is still present.', 'Set your publisher and support URL before distribution.');
    else check('publisher', 'pass', 'Publisher and support metadata are customized.');
  } catch (failure) {check('package', 'error', failure instanceof Error ? failure.message.slice(0, 2_048) : 'Package metadata is invalid.', 'Correct plugin.json, disclosure.json and dds-package.json; do not add private files.');}
  try{
    const project=await readJson(path.join(root,'package.json'));
    if(project.dependencies?.[sdk.name]!==`https://github.com/Altifigence/dds-plugin-sdk/releases/download/v${sdk.version}/altifigence-dds-plugin-sdk-${sdk.version}.tgz`)check('dependency-pin','warning','The project does not pin this exact official SDK archive.','Review the selected SDK source and version before installing.');
    else check('dependency-pin','pass','The development dependency pins this exact official SDK archive.');
    if(project.devDependencies?.typescript!==undefined)check('typescript','pass',`The project explicitly declares a separate TypeScript development dependency (${project.devDependencies.typescript}).`);
  }catch{check('project','error','Project package.json is missing or invalid.','Provide inert development metadata; doctor does not install or run scripts.');}
  try {
    const packagePath = createRequire(path.join(root, 'package.json')).resolve('@altifigence/dds-plugin-sdk/package.json');
    const installed = await readJson(packagePath);
    if (installed.name !== sdk.name || typeof installed.version !== 'string' || installed.version.split('.').slice(0, 2).join('.') !== sdkLine || !/^\d+\.\d+\.\d+(?:$|[-+])/.test(installed.version)) throw error(`Install SDK ${sdkLine}.x for these development tools.`);
    check('sdk', 'pass', `SDK ${installed.version} resolves from this project.`);
  } catch {check('sdk', 'error', `SDK ${sdkLine}.x is not installed for this project.`, 'Run npm install --ignore-scripts using the pinned SDK archive in package.json.');}
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
  plainOptions(options, ['trustLocalCode', 'watch', 'command', 'input', 'job', 'timeoutMs', 'signal', 'onEvent','profile','debug','debugWait']);
  if (options.trustLocalCode !== true) throw error('dev executes local plugin code; pass --trust-local-code for a plugin you trust.');
  for (const key of ['watch', 'job','profile','debug','debugWait']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw error(`Invalid ${key} option`);
  const {watch = false, command, job = false, timeoutMs = 30_000, signal, onEvent = () => {},profile=false,debug=false,debugWait=false} = options;
  if(debugWait&&!debug)throw error('debugWait requires debug.');
  if(debug&&timeoutMs>30000)throw error('Debug sessions are limited to 30000 ms per child.');
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
    child = owned; let bytes = 0, completed = false,debugReported=false;
    const debugDeadline=Date.now()+timeoutMs;
    const output = (stream, chunk) => {
      if (child !== owned || stopping) return; bytes += chunk.length;
      if (bytes > 262_144) {void finish(error('Development output exceeded 256 KiB')); return;}
      try {emit({type: 'output', stream, text: chunk.toString('utf8')});} catch (failure) {void finish(failure);}
    };
    owned.stdout.on('data', chunk => output('stdout', chunk)); owned.stderr.on('data', chunk => output('stderr', chunk));
    owned.once('error', failure => {void finish(error(`Development process failed: ${failure.code ?? 'spawn'}`));});
    owned.on('message', message => {
      if (child !== owned || stopping || completed || !message) return;
      if(message.type==='debug'&&debug&&!debugReported){
        try{const url=new URL(message.url);if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash||!/^\/[a-f0-9-]{36}$/.test(url.pathname))throw error('Invalid development debug endpoint');debugReported=true;emit({type:'debug',run:runs,pid:owned.pid,url:url.href,expiresInMs:Math.max(0,debugDeadline-Date.now())});}
        catch(failure){void finish(failure);}return;
      }
      if(message.type!=='complete'||typeof message.ok!=='boolean')return;
      if(profile){try{emit({type:'profile',run:runs,report:parseDiagnosticReport(message.profile)});}catch(failure){void finish(failure);return;}}
      completed = true; lastOk = message.ok; clearTimeout(deadline);
      tail = tail.then(async () => {if (child !== owned || stopping) return; await stopTree(owned); emit({type: 'complete', run: runs, ok: lastOk}); if (!watch) await finish();}).catch(finish);
    });
    owned.once('exit', () => {
      if (child === owned && !stopping && !changing && !completed) {
        lastOk = false; completed = true; clearTimeout(deadline);
        tail = tail.then(async () => {if(child !== owned || stopping)return; await stopTree(owned); emit({type: 'complete', run: runs, ok: false}); if (!watch) await finish();}).catch(finish);
      }
    });
    deadline = setTimeout(() => {if (child === owned && !stopping) {lastOk = false; completed = true; tail = tail.then(async () => {if(child !== owned || stopping)return; await stopTree(owned); emit({type: 'timeout', run: runs, ok: false}); if (!watch) await finish();}).catch(finish);}}, debug?timeoutMs:timeoutMs + 1_000);
    owned.send({directory: root, command, input, job, timeoutMs,profile,debug,debugWait}, failure => {if (failure && !stopping && !completed) void finish(error('Could not configure the development process'));});
    emit({type: 'start', run: runs, pid: owned.pid});
  };
  const onAbort = () => {void finish();}; signal?.addEventListener('abort', onAbort, {once: true});
  if (signal?.aborted) void finish(); else tail = tail.then(restart).catch(finish);
  return done;
}
