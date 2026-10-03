import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('public package guard rejects extra files, credentials and private imports', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dds-public-guard-')));
  t.after(async () => { assert.equal(path.dirname(root), await realpath(tmpdir())); await rm(root, {recursive:true}); });
  await mkdir(path.join(root, 'scripts')); await mkdir(path.join(root, 'src'));
  for (const name of ['scripts/check-public-surface.mjs','src/publication-policy.mjs','src/patterns.mjs']) {
    await writeFile(path.join(root, name), await readFile(new URL(`../${name}`, import.meta.url)));
  }
  await writeFile(path.join(root, 'src/hello.mjs'), 'export const hello = 1;');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({name:'dds-public-guard-fixture',version:'1.0.0',type:'module',files:['src/','PUBLIC_SURFACE.json']}));
  await writeFile(path.join(root, 'PUBLIC_SURFACE.json'), JSON.stringify({schemaVersion:1,packageFiles:['package.json','PUBLIC_SURFACE.json','src/hello.mjs','src/publication-policy.mjs','src/patterns.mjs']}));
  const git = args => {
    const result=spawnSync('git',args,{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  };
  git(['init','--quiet']); git(['add','.']);
  const run = () => spawnSync(process.execPath,['scripts/check-public-surface.mjs'],{cwd:root,encoding:'utf8',timeout:120_000});
  const valid=run(); assert.equal(valid.status,0,valid.stderr);
  await writeFile(path.join(root, 'src/unreviewed.mjs'), 'export const extra = 1;');
  assert.notEqual(run().status,0,'untracked package file must fail');
  await rm(path.join(root, 'src/unreviewed.mjs'));
  const token=['gh','p_', 'x'.repeat(36)].join('');
  await writeFile(path.join(root, 'src/hello.mjs'), `export const accidental=${JSON.stringify(token)};`);
  const rejected=run(); assert.notEqual(rejected.status,0); assert.ok(!rejected.stderr.includes(token));
  await writeFile(path.join(root, 'src/hello.mjs'), `import x from '${['@altifigence','internal'].join('-')}/private';`);
  assert.notEqual(run().status,0,'private dependency must fail');
});
