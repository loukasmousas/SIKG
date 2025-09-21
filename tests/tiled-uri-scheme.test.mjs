// tests/tiled-uri-scheme.test.mjs
// Ensures tiled manifests use unified URI scheme: uri://<imageName>/tiledImage/<id>
import path from 'path';
import { fileURLToPath } from 'url';
import { processImage as processTiled } from '../src/tiled/TiledMLMain.js';
import TiledMLSerializer from '../src/tiled/TiledMLSerializer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function buildTiled(imagePath) {
  await processTiled(imagePath); // always regenerate to ensure tiled manifest
  const outDir = path.join(process.cwd(), 'output');
  const base = path
    .basename(imagePath, path.extname(imagePath))
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(outDir, base + '.json');
}

(async () => {
  try {
    const sample = path.join(process.cwd(), 'input-images', 'Alte_Donau.jpg');
    const manifestPath = await buildTiled(sample);
    const { regionManager } = await TiledMLSerializer.load(manifestPath);
    if (!regionManager || !regionManager.regions) {
      throw new Error('No regions returned from tiled serializer load');
    }
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
        if (ridStr.startsWith('manual-')) continue; // manual regions use manual-region segment
        if (!r.metadata.uri.includes('/tiledImage/')) {
          bad.push({
            id: r.id,
            uri: r.metadata.uri,
            reason: 'missing /tiledImage/ segment',
          });
        }
      }
    }
    if (bad.length) {
      console.error('Tiled URI scheme violations:', bad);
      process.exitCode = 1;
    } else {
      console.log('Tiled URI scheme test passed.');
    }
  } catch (e) {
    console.error('Tiled URI scheme test failed:', e.message);
    process.exitCode = 1;
  }
})();
