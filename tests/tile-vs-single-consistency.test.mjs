// tile-vs-single-consistency.test.mjs
// For tiny image tileSize > image dims so tiled should act like single (with mocked models for determinism).
import sharp from 'sharp';
import ImageProcessor from '../src/single/ImageProcessor.js';
import TiledMLProcessor from '../src/tiled/TiledMLProcessor.js';

async function tiny() {
  return sharp({
    create: {
      width: 64,
      height: 48,
      channels: 4,
      background: { r: 12, g: 34, b: 56, alpha: 255 },
    },
  })
    .png()
    .toBuffer();
}

async function run() {
  const buf = await tiny();
  const ip = new ImageProcessor(buf, 'tiny', { performanceProfile: 'fast' });
  ip.mlProcessor.loadCocoModel = async () => {
    ip.mlProcessor.cocoModel = {
      detect: async () => [
        { class: 'person', score: 0.8, bbox: [5, 5, 20, 20] },
      ],
    };
  };
  ip.mlProcessor.loadDeepLabModel = async () => {
    ip.mlProcessor.deeplabModel = null;
  };
  ip.mlProcessor.detectRegions = async () => ({
    detections: [
      {
        class: 'person',
        score: 0.8,
        boundary: { x1: 5, y1: 5, x2: 25, y2: 25 },
      },
    ],
    deeplabSegmentation: null,
  });
  await ip.processImage();
  const singleLabels = new Set(ip.regionManager.regions.map((r) => r.tags[0]));

  const tp = new TiledMLProcessor(buf, {
    tileSize: 128,
    halo: 0,
    performanceProfile: 'fast',
    cocoScoreThreshold: 0.1,
  });
  tp.loadModels = async () => {
    tp.coco = {
      detect: async () => [
        { class: 'person', score: 0.8, bbox: [5, 5, 20, 20] },
      ],
    };
    tp.deeplab = { segment: async () => ({}) };
  };
  await tp.processImage();
  const tiledLabels = new Set(tp.regionManager.regions.map((r) => r.tags[0]));
  if (singleLabels.size !== tiledLabels.size)
    throw new Error('Label set size mismatch');
  if (![...singleLabels].every((l) => tiledLabels.has(l)))
    throw new Error('Label sets differ');
  console.log('Tile vs single consistency test passed.');
}
run().catch((e) => {
  console.error('Tile vs single consistency test failed:', e.message);
  process.exitCode = 1;
});
