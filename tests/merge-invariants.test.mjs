// merge-invariants.test.mjs
// Validates mergeOverlappingRegions invariants.
import RegionManager from '../src/common/RegionManager.js';

function make(id, b) {
  return { id, boundary: b, tags: ['x'], metadata: { uri: `uri://r/${id}` } };
}

async function run() {
  const rm = new RegionManager();
  // Overlapping boxes 0 & 1; separate 2
  rm.regions.push(make(0, { x1: 0, y1: 0, x2: 50, y2: 50 }));
  rm.regions.push(make(1, { x1: 25, y1: 25, x2: 80, y2: 80 }));
  rm.regions.push(make(2, { x1: 200, y1: 200, x2: 260, y2: 260 }));
  const before = rm.regions.length;
  const prov = rm.mergeOverlappingRegions(0.1);
  const after = rm.regions.length;
  if (after >= before)
    throw new Error('Expected region count reduction after merge');
  const merged = prov.find((p) => p.sources.length > 1);
  if (!merged) throw new Error('No provenance entry for merge');
  const tgt = rm.regions[merged.target];
  // merged boundary must cover both sources
  const bx = tgt.boundary;
  if (bx.x1 !== 0 || bx.y1 !== 0 || bx.x2 < 80 || bx.y2 < 80)
    throw new Error('Merged boundary does not encompass sources');
  console.log('Merge invariants test passed.');
}

run().catch((e) => {
  console.error('Merge invariants test failed:', e.message);
  process.exitCode = 1;
});
