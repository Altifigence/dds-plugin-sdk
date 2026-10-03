import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SCHEMAS } from '../src/schemas.mjs';

const mode = process.argv[2];
if (!['--write', '--check'].includes(mode)) throw new Error('Use --write or --check');
const directory = new URL('../schemas/', import.meta.url);
if (mode === '--write') await mkdir(directory, {recursive: true});
for (const [name, schema] of Object.entries(SCHEMAS)) {
  const path = new URL(`${name}.schema.json`, directory);
  const expected = `${JSON.stringify(schema, null, 2)}\n`;
  if (mode === '--write') await writeFile(path, expected);
  else if (await readFile(path, 'utf8') !== expected) throw new Error(`Schema drift: ${name}; run npm run schemas:write`);
}
console.log(`Schemas ${mode === '--write' ? 'generated' : 'verified'}: ${Object.keys(SCHEMAS).length}`);
