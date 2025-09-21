// slim-diff.test.mjs
// Produces manifests with and without slimming and confirms only geometry keys removed.
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
const root = process.cwd();
const img = join(root, 'input-images', 'barcelona.jpg');
const jsonPath = join(root, 'output', 'barcelona.json');

async function runOnce(flag) {
  return new Promise((res, rej) => {
    const env = { ...process.env, PHT_SLIM_JSON: flag ? '1' : '0' };
    const p = spawn('node', ['src/single/Main.js', img], { cwd: root, env });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(err))));
  });
}

async function run() {
  await runOnce(false);
  const full = JSON.parse(await readFile(jsonPath, 'utf8'));
  await runOnce(true);
  const slim = JSON.parse(await readFile(jsonPath, 'utf8'));
  const fullRegions = Object.values(full.metadataIndex.index);
  const slimRegions = Object.values(slim.metadataIndex.index);
  if (!fullRegions.length || !slimRegions.length)
    throw new Error('No regions present');
  const geomKeys = ['x', 'y', 'w', 'h'];
  const slimHasGeom = slimRegions.some((r) => geomKeys.some((k) => k in r));
  if (slimHasGeom) throw new Error('Slim version still has geometry');
  const sampleFull = fullRegions[0];
  const sampleSlim = slimRegions[0];
  const sharedKeys = Object.keys(sampleFull).filter(
    (k) => !geomKeys.includes(k),
  );
  const missing = sharedKeys.filter((k) => !(k in sampleSlim));
  if (missing.length)
    throw new Error('Slim removed unexpected keys: ' + missing.join(','));
  console.log('Slim diff test passed.');
}
run().catch((e) => {
  console.error('Slim diff test failed:', e.message);
  process.exitCode = 1;
});
