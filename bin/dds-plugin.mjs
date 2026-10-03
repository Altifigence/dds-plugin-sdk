#!/usr/bin/env node
import { packPlugin, validatePluginPackage, verifyPluginArchive } from '../src/publishing.mjs';

const [command, directory, ...args] = process.argv.slice(2);
try {
  const usage = 'Usage: dds-plugin validate <directory> | dds-plugin pack <directory> --out <directory> | dds-plugin verify <archive.tgz> [--metadata <release.json>] [--sha256 <expected-hash>]';
  if (!directory || !['validate', 'pack', 'verify'].includes(command) || command === 'validate' && args.length || command === 'pack' && (args.length !== 2 || args[0] !== '--out' || !args[1])) {
    throw new Error(usage);
  }
  let result;
  if (command === 'verify') {
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      const key = {'--metadata': 'metadataPath', '--sha256': 'expectedSha256'}[args[index]];
      if (!key || !args[index + 1] || Object.hasOwn(options, key)) throw new Error(usage);
      options[key] = args[index + 1];
    }
    result = await verifyPluginArchive(directory, options);
  } else result = command === 'validate' ? await validatePluginPackage(directory) : await packPlugin(directory, {out: args[1]});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Plugin packaging failed'}\n`);
  process.exitCode = 1;
}
