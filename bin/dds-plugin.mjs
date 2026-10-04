#!/usr/bin/env node
import {packPlugin, validatePluginPackage, verifyPluginArchive} from '../src/publishing.mjs';
import {initPlugin, doctorPlugin, runPluginDev, generatePluginContracts} from '../src/devtools.mjs';

const usage = `Usage:
  dds-plugin init <new-directory> [--id <id>] [--publisher <id>] [--name <name>] [--template <command|language|theme|job|browser|configuration>] [--dry-run] [--license <Apache-2.0|LicenseRef-Proprietary>] [--license-file <file>]
  dds-plugin generate <directory> [--check|--dry-run] [--expected-digest <previous-sha256>]
  dds-plugin doctor <directory> [--json]
  dds-plugin dev <directory> --trust-local-code [--watch] [--command <id>] [--input <json>] [--job] [--timeout-ms <ms>] [--profile] [--debug] [--debug-wait]
  dds-plugin validate <directory>
  dds-plugin pack <directory> --out <directory>
  dds-plugin verify <archive.tgz> [--metadata <release.json>] [--sha256 <expected-hash>]`;
function flags(args, values = [], booleans = []) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (Object.hasOwn(result, name) || !values.includes(name) && !booleans.includes(name)) throw new Error(usage);
    if (booleans.includes(name)) result[name] = true;
    else {const value = args[++index]; if (!value || value.startsWith('--')) throw new Error(usage); result[name] = value;}
  }
  return result;
}
const [command, directory, ...args] = process.argv.slice(2);
try {
  if (command === '--help' && directory === undefined) process.stdout.write(`${usage}\n`);
  else {
    if (!directory) throw new Error(usage);
    let result;
    if (command === 'init') {
      const values = flags(args, ['--id', '--publisher', '--name', '--template', '--license', '--license-file'], ['--dry-run']);
      result = await initPlugin(directory, Object.fromEntries(Object.entries(values).map(([key, value]) => [key.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()), value])));
    } else if (command === 'generate') {
      const values=flags(args,['--expected-digest'],['--check','--dry-run']);
      result=await generatePluginContracts(directory,{...(values['--check']?{check:true}:{}),...(values['--dry-run']?{dryRun:true}:{}),...(values['--expected-digest']?{expectedDigest:values['--expected-digest']}:{})});
      if(result.ok===false)process.exitCode=1;
    } else if (command === 'doctor') {
      const values = flags(args, [], ['--json']); result = await doctorPlugin(directory);
      if (!result.ok) process.exitCode = 1;
      if (!values['--json']) {process.stdout.write(`${result.checks.map(check => `${check.status.toUpperCase()} ${check.id}: ${check.message}${check.status === 'error' && check.fix ? `\n  ${check.fix}` : ''}`).join('\n')}\n`); result = undefined;}
    } else if (command === 'dev') {
      const values = flags(args, ['--command', '--input', '--timeout-ms'], ['--trust-local-code', '--watch', '--job', '--profile', '--debug', '--debug-wait']);
      if (values['--timeout-ms'] && !/^[1-9]\d*$/.test(values['--timeout-ms'])) throw new Error('Invalid --timeout-ms');
      const controller = new AbortController(); const stop = () => controller.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        result = await runPluginDev(directory, {trustLocalCode: values['--trust-local-code'] === true, watch: values['--watch'] === true, profile: values['--profile'] === true, debug: values['--debug'] === true, debugWait: values['--debug-wait'] === true, job: values['--job'] === true, ...(values['--command'] ? {command: values['--command']} : {}), ...(values['--input'] ? {input: JSON.parse(values['--input'])} : {}), ...(values['--timeout-ms'] ? {timeoutMs: Number(values['--timeout-ms'])} : {}), signal: controller.signal, onEvent: event => process.stdout.write(`${JSON.stringify(event)}\n`)});
        if (!result.ok) process.exitCode = 1;
      } finally {process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);}
    } else if (command === 'verify') {
      const values = flags(args, ['--metadata', '--sha256']);
      result = await verifyPluginArchive(directory, {...(values['--metadata'] ? {metadataPath: values['--metadata']} : {}), ...(values['--sha256'] ? {expectedSha256: values['--sha256']} : {})});
    } else if (command === 'pack') {
      const values = flags(args, ['--out']); if (!values['--out']) throw new Error(usage); result = await packPlugin(directory, {out: values['--out']});
    } else if (command === 'validate') {flags(args); result = await validatePluginPackage(directory);}
    else throw new Error(usage);
    if (result !== undefined) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (failure) {
  process.stderr.write(`${failure instanceof Error ? failure.message : 'Plugin command failed'}\n`);
  process.exitCode = 1;
}
