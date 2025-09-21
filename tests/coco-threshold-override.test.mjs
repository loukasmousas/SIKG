// coco-threshold-override.test.mjs
// Ensures per-class threshold override allows low-score class while excluding others.
import TiledMLProcessor from '../src/tiled/TiledMLProcessor.js';
import sharp from 'sharp';

async function img() {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 255 },
    },
  })
    .png()
    .toBuffer();
}

async function run() {
  const buffer = await img();
  const proc = new TiledMLProcessor(buffer, {
    tileSize: 64,
    halo: 0,
    performanceProfile: 'fast',
    cocoScoreThreshold: 0.9,
    cocoClassThresholds: { person: 0.1 },
  });
  proc.loadModels = async () => {
    proc.coco = {
      detect: async () => [
        { class: 'person', score: 0.2, bbox: [5, 5, 10, 10] },
        { class: 'dog', score: 0.2, bbox: [20, 20, 10, 10] },
      ],
    };
    proc.deeplab = { segment: async () => ({}) };
  };
  await proc.processImage();
  const regions = proc.regionManager.regions;
  const hasPerson = regions.some((r) => r.tags.includes('person'));
  const hasDog = regions.some((r) => r.tags.includes('dog'));
  if (!hasPerson)
    throw new Error('Expected person region to pass override threshold');
  if (hasDog)
    throw new Error('Dog should have been filtered out by global threshold');
  console.log('COCO per-class threshold override test passed.');
}
run().catch((e) => {
  console.error('COCO threshold override test failed:', e.message);
  process.exitCode = 1;
});
