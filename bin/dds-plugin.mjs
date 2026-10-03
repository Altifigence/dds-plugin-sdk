#!/usr/bin/env node
import { packPlugin, validatePluginPackage } from '../src/publishing.mjs';

const [command, directory, ...args] = process.argv.slice(2);
try {
  if (!directory || !['validate', 'pack'].includes(command) || command === 'validate' && args.length || command === 'pack' && (args.length !== 2 || args[0] !== '--out' || !args[1])) {
    throw new Error('Usage: dds-plugin validate <directory> | dds-plugin pack <directory> --out <directory>');
  }
  const result = command === 'validate' ? await validatePluginPackage(directory) : await packPlugin(directory, {out: args[1]});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Plugin packaging failed'}\n`);
  process.exitCode = 1;
}
