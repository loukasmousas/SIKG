// tests/single-uri-scheme.test.mjs
// Ensures single-image manifests use unified URI scheme: uri://<imageName>/singleImage/<id>
import path from 'path';
import { fileURLToPath } from 'url';
import { processImage as processSingle } from '../src/single/Main.js';
import Serializer from '../src/common/Serializer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function buildSingle(imagePath) {
  // Always regenerate to be deterministic (fast profile to skip segmentation for speed)
  await processSingle(imagePath, { performanceProfile: 'fast' });
  const outDir = path.join(process.cwd(), 'output');
  const base = path
    .basename(imagePath, path.extname(imagePath))
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(outDir, base + '.json');
}

(async () => {
  try {
    const sample = path.join(process.cwd(), 'input-images', 'barcelona.jpg');
    const manifestPath = await buildSingle(sample);
    // Load via Serializer to mirror real usage
    const ser = new Serializer(null, null, null);
    const { metadataIndex: _metadataIndex, regionManager } =
      await ser.load(manifestPath);
    if (!regionManager || !regionManager.regions)
      throw new Error('No regions in single-image manifest');
    const imgName = path.basename(manifestPath, '.json');
    const bad = [];
    for (const r of regionManager.regions) {
      if (r && r.metadata && r.metadata.uri) {
        if (!r.metadata.uri.startsWith(`uri://${imgName}/`)) {
          bad.push({
            id: r.id,
            uri: r.metadata.uri,
            reason: 'wrong image prefix',
          });
          continue;
        }
        const ridStr = String(r.id);
        if (ridStr.startsWith('manual-')) continue; // manual segment separate
        if (!r.metadata.uri.includes('/singleImage/')) {
          bad.push({
            id: r.id,
            uri: r.metadata.uri,
            reason: 'missing /singleImage/ segment',
          });
        }
      }
    }
    if (bad.length) {
      console.error('Single-image URI scheme violations:', bad);
      process.exitCode = 1;
    } else {
      console.log('Single-image URI scheme test passed.');
    }
  } catch (e) {
    console.error('Single-image URI scheme test failed:', e.message);
    process.exitCode = 1;
  }
})();
