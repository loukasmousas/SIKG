// tiled-halo-adaptive.test.mjs
// Verifies tiling coverage + adaptive refinement triggers additional tiles.
import sharp from 'sharp';
import TiledMLProcessor from '../src/tiled/TiledMLProcessor.js';

async function syntheticImage(w = 320, h = 240) {
  const buf = await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 255 },
    },
  })
    .png()
    .toBuffer();
  return buf;
}

async function run() {
  const img = await syntheticImage();
  const proc = new TiledMLProcessor(img, {
    tileSize: 128,
    halo: 16,
    adaptiveStride: true,
    densityThreshold: 0,
    maxAdaptiveRounds: 1,
    performanceProfile: 'balanced',
    cocoScoreThreshold: 0.5,
  });
  // Inject fake detections + minimal deeplab segmentation to keep pipeline happy
  proc.loadModels = async () => {
    proc.coco = {
      detect: async () => [
        { bbox: [10, 10, 20, 20], score: 0.99, class: 'object' },
      ],
    };
    proc.deeplab = {
      segment: async () => ({ legend: {}, segmentationMap: new Uint8Array(1) }),
    };
  };
  await proc.processImage();
  if (!proc.tiles.length) throw new Error('No tiles generated');
  if (proc.adaptiveRounds !== 1)
    throw new Error('Adaptive refinement did not trigger');
  console.log('Tiled halo + adaptive test passed.');
}
run().catch((e) => {
  console.error('Tiled halo/adaptive test failed:', e.message);
  process.exitCode = 1;
});
