// noop-merge.test.mjs
import RegionManager from '../src/common/RegionManager.js';

const rm = new RegionManager();
rm.regions.push({
  id: 0,
  boundary: { x1: 0, y1: 0, x2: 10, y2: 10 },
  tags: ['a'],
  metadata: {},
});
rm.regions.push({
  id: 1,
  boundary: { x1: 20, y1: 20, x2: 30, y2: 30 },
  tags: ['b'],
  metadata: {},
});
const before = rm.regions.length;
const prov = rm.mergeOverlappingRegions(0.5);
if (prov.some((p) => p.sources.length > 1)) {
  console.error('Unexpected merge occurred');
  process.exitCode = 1;
} else if (rm.regions.length !== before) {
  console.error('Region count changed unexpectedly');
  process.exitCode = 1;
} else console.log('No-op merge test passed.');
