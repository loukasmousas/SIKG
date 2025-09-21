// profile-fast.test.mjs
// Ensures performanceProfile='fast' skips DeepLab regions (no ex:detectedBy deeplab) while COCO detections appear.
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join } from 'path';

const root = process.cwd();
const img = join(root, 'input-images', 'barcelona.jpg');
const outJson = join(root, 'output', 'barcelona.json');

async function runMainFast() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PHT_SLIM_JSON: '0',
      PERFORMANCE_PROFILE: 'fast',
    };
    const p = spawn('node', ['src/single/Main.js', img, '--profile', 'fast'], {
      cwd: root,
      env,
    });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('Main fast failed: ' + stderr)),
    );
  });
}

async function main() {
  await runMainFast();
  const json = JSON.parse(await readFile(outJson, 'utf8'));
  const rdf = json.metadataIndex?.rdf || '';
  if (/deeplab-ade20k/i.test(rdf))
    throw new Error('DeepLab triples present in fast profile (expected skip)');
  if (!/coco-ssd/.test(rdf))
    throw new Error('Expected coco-ssd triples missing');
  console.log('Fast profile test passed.');
}

main().catch((e) => {
  console.error('Fast profile test failed:', e.message);
  process.exitCode = 1;
});
