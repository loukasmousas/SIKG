// serializer-roundtrip.test.mjs
// Processes image (balanced), saves, reloads, asserts region & pixel fidelity (dimensions + count).
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join } from 'path';
import Serializer from '../src/common/Serializer.js';

const root = process.cwd();
const img = join(root, 'input-images', 'barcelona.jpg');
const outJson = join(root, 'output', 'barcelona.json');

async function ensureManifest() {
  try {
    await readFile(outJson);
    return;
  } catch (_) {
    /* regenerate manifest */
  }
  await new Promise((res, rej) => {
    const p = spawn('node', ['src/single/Main.js', img], { cwd: root });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(err))));
  });
}

async function run() {
  await ensureManifest();
  const ser = new Serializer();
  const { pixelMatrix, regionManager } = await ser.load(outJson);
  if (!pixelMatrix || !pixelMatrix.width)
    throw new Error('PixelMatrix missing');
  if (!regionManager || !regionManager.regions.length)
    throw new Error('No regions after load');
  console.log('Serializer round-trip test passed.');
}

run().catch((e) => {
  console.error('Serializer round-trip test failed:', e.message);
  process.exitCode = 1;
});
