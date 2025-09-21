// spatial-relationships.test.mjs
// Crafts synthetic regions then invokes ImageProcessor.autoCreateRelationships (bypassing ML) to assert expected predicates.
import ImageProcessor from '../src/single/ImageProcessor.js';

async function stubIP() {
  const ip = Object.create(ImageProcessor.prototype);
  ip.options = {
    spatialRelationships: true,
    nearDistance: 30,
    maxNearPairs: 10,
    nearEnabled: true,
    containsEnabled: true,
    overlapsEnabled: true,
    edgeTouchEnabled: true,
    insideRatioEnabled: true,
    minInsideRatio: 0.05,
    minOverlapIoU: 0.01,
    minOverlapArea: 1,
    minRegionAreaForNear: 1,
  };
  const MetadataIndex = (await import('../src/common/MetadataIndex.js'))
    .default;
  ip.regionManager = { regions: [] };
  ip.metadataIndex = new MetadataIndex();
  return ip;
}

async function run() {
  const ip = await stubIP();
  const mk = (id, b) => ({
    id,
    boundary: b,
    tags: ['t'],
    metadata: { uri: `uri://r/${id}` },
  });
  ip.regionManager.regions.push(
    mk(0, { x1: 0, y1: 0, x2: 100, y2: 100 }),
    mk(1, { x1: 10, y1: 10, x2: 40, y2: 40 }),
    mk(2, { x1: 150, y1: 10, x2: 190, y2: 50 }),
    // Region 3 adjusted to overlap region 1 (partial overlap) without full containment
    mk(3, { x1: 30, y1: 10, x2: 80, y2: 40 }),
  );
  ImageProcessor.prototype.autoCreateRelationships.call(ip);
  const store = ip.metadataIndex.store;
  const count = (pred) => store.getQuads(null, pred, null, null).length;
  const _NN = 'http://example.org/metadata#near';
  const CON = 'http://example.org/metadata#contains';
  const OV = 'http://example.org/metadata#overlaps';
  const IN = 'http://example.org/metadata#inside';
  const IR = 'http://example.org/metadata#insideRatio';
  if (count(CON) === 0) throw new Error('Expected contains relationship');
  if (count(IN) === 0) throw new Error('Expected inside relationship');
  if (count(IR) === 0) throw new Error('Expected insideRatio relationship');
  if (count(OV) === 0) throw new Error('Expected overlaps relationship');
  console.log('Spatial relationships test passed.');
}
run().catch((e) => {
  console.error('Spatial relationships test failed:', e.message);
  process.exitCode = 1;
});
