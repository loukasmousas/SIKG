// tests/merge-highlight.test.mjs
// Verifies that mergedFrom provenance results in highlight mapping to merged region boundary.
import RegionManager from '../src/common/RegionManager.js';
import MetadataIndex from '../src/common/MetadataIndex.js';

function makeRegion(boundary, tags, id) {
  return {
    id,
    boundary,
    tags,
    metadata: { uri: `uri://img/singleImage/${id}` },
  };
}

// Simulate merging behaviour similar to RegionManager.mergeOverlappingRegions output + provenance triples.
async function runTest() {
  const rm = new RegionManager();
  // Manually push regions to control IDs
  rm.regions.push(makeRegion({ x1: 0, y1: 0, x2: 50, y2: 50 }, ['a'], 0));
  rm.regions.push(makeRegion({ x1: 10, y1: 10, x2: 60, y2: 60 }, ['a'], 1));
  rm.regions.push(makeRegion({ x1: 200, y1: 200, x2: 250, y2: 250 }, ['b'], 2));

  // Force a merge of 0 & 1 into new region 0 style output
  const provenance = rm.mergeOverlappingRegions(0.1); // updates rm.regions
  // Build metadata index with mergedFrom triples
  const mi = new MetadataIndex();
  provenance.forEach((p) => {
    if (p.sources.length > 1) {
      const targetUri = rm.regions[p.target].metadata.uri;
      p.sources.forEach((srcId) => {
        if (srcId === p.target) return;
        const srcUri = `uri://img/singleImage/${srcId}`;
        mi.insertQuads(
          `@prefix ex:<http://example.org/> . <${targetUri}> ex:mergedFrom <${srcUri}> .`,
        );
      });
    }
  });

  // Rebuild URI maps (inline simplified copy of rebuildUriMaps logic)
  const uriToRegionId = new Map();
  const uriToBoundary = new Map();
  rm.regions.forEach((r) => {
    uriToRegionId.set(r.metadata.uri, r.id);
    uriToBoundary.set(r.metadata.uri, r.boundary);
  });
  const MERGED_FROM = 'http://example.org/mergedFrom';
  mi.store
    .getQuads(null, null, null, null)
    .filter((q) => q.predicate.value === MERGED_FROM)
    .forEach((q) => {
      const target = q.subject.value;
      const src = q.object.value;
      const rid = uriToRegionId.get(target);
      const b = uriToBoundary.get(target);
      if (rid != null) {
        uriToRegionId.set(src, rid);
        if (b) uriToBoundary.set(src, b);
      }
    });

  // Assertions: source region URI should map to target boundary
  const srcUri = 'uri://img/singleImage/1';
  const targetUri = rm.regions[0].metadata.uri; // after merge id 0 boundary expanded
  const mappedBoundary = uriToBoundary.get(srcUri);
  const targetBoundary = uriToBoundary.get(targetUri);
  if (!mappedBoundary)
    throw new Error('No boundary mapped for merged source URI');
  if (
    mappedBoundary.x1 !== targetBoundary.x1 ||
    mappedBoundary.x2 !== targetBoundary.x2
  ) {
    throw new Error('Merged source boundary does not match target boundary');
  }
  console.log('Provenance highlight mapping test passed.');
}

runTest().catch((e) => {
  console.error('Provenance test failed:', e.message);
  process.exitCode = 1;
});
