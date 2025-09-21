// tests/slim-json.test.mjs
// Minimal smoke test: with PHT_SLIM_JSON=1 JSON output should omit geometry fields in region index entries.
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = join(__dirname, '..');
const img = join(root, 'input-images', 'barcelona.jpg');
const outJson = join(root, 'output', 'barcelona.json');

async function run() {
  await rm(outJson, { force: true }).catch(() => {});
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PHT_SLIM_JSON: '1' };
    const p = spawn('node', ['src/single/Main.js', img], { cwd: root, env });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    p.on('close', async (code) => {
      if (code !== 0) return reject(new Error('Main.js failed: ' + stderr));
      try {
        const json = JSON.parse(await readFile(outJson, 'utf8'));
        const regions = Object.values(json.metadataIndex?.index || {});
        if (!regions.length) throw new Error('No regions produced');
        const hasGeometry = regions.some(
          (r) => 'x' in r || 'y' in r || 'w' in r || 'h' in r,
        );
        if (hasGeometry) {
          throw new Error('Geometry fields present despite slimming flag');
        }
        console.log('Slim JSON test passed (no x,y,w,h in region index).');
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

run().catch((e) => {
  console.error('Slim JSON test failed:', e.message);
  process.exitCode = 1;
});
