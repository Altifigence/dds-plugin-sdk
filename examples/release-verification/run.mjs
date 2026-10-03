import assert from 'node:assert/strict';
import {cp, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packPlugin, verifyPluginArchive} from '@altifigence/dds-plugin-sdk/publishing';

const parent = await realpath(tmpdir());
const root = await realpath(await mkdtemp(join(parent, 'dds-release-example-')));
try {
  await cp(fileURLToPath(new URL('../publishable-plugin/', import.meta.url)), join(root, 'plugin'), {recursive: true});
  const packed = await packPlugin(join(root, 'plugin'), {out: join(root, 'dist')});
  // This local example owns both sides. For someone else's download, obtain
  // the expected hash independently through a trusted release channel.
  const receipt = await verifyPluginArchive(packed.archivePath, {expectedSha256: packed.artifact.sha256});
  assert.equal(receipt.checksumPinned, true);
  const changed = await readFile(packed.archivePath);
  changed[changed.length - 1] ^= 1;
  const tamperedPath = join(root, 'tampered.tgz');
  await writeFile(tamperedPath, changed);
  await assert.rejects(verifyPluginArchive(tamperedPath, {
    metadataPath: packed.metadataPath, expectedSha256: packed.artifact.sha256,
  }), /expectedSha256/);
  console.log(`Release verification: ${receipt.files.length} files, hash pin and tampering check passed`);
} finally {
  assert.equal(dirname(await realpath(root)), parent);
  assert.ok(basename(root).startsWith('dds-release-example-'));
  await rm(root, {recursive: true});
}
