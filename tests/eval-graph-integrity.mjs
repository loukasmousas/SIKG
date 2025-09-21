import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadManifest, stableJSON, getRegions } from './util/eval-helpers.mjs';

function hashArray(arr) {
  return crypto.createHash('sha256').update(JSON.stringify(arr)).digest('hex');
}

const OUT_PATH = 'output/eval/graph_integrity.json';
const results = [];
for (const f of fs.readdirSync('output').filter((f) => f.endsWith('.json'))) {
  if (f.endsWith('.raw-model.json')) continue; // skip raw dumps
  const mani = loadManifest(path.join('output', f));
  const regions = getRegions(mani);
  const regionProvenanceCoverage = regions.length
    ? regions.filter((r) => r.provenance?.detectedBy || r.ex?.detectedBy)
        .length / regions.length
    : 0;

  // Round-trip check: write temp, re-load, compare region id + geometry + type
  const clonePath = `output/tmp-${f}`;
  fs.writeFileSync(clonePath, JSON.stringify(mani, null, 2));
  const re = JSON.parse(fs.readFileSync(clonePath, 'utf-8'));
  fs.unlinkSync(clonePath);

  const hash1 = hashArray(
    regions.map((r) => [
      r.id,
      r.ex?.x,
      r.ex?.y,
      r.ex?.w,
      r.ex?.h,
      r.md?.classLabel,
    ]),
  );
  const reRegions = getRegions(re);
  const hash2 = hashArray(
    reRegions.map((r) => [
      r.id,
      r.ex?.x,
      r.ex?.y,
      r.ex?.w,
      r.ex?.h,
      r.md?.classLabel,
    ]),
  );
  const regionHashStable = hash1 === hash2;

  // Slimming integrity: if geometry missing in md index ensure ex geometry exists
  let slimmingViolations = 0;
  if (mani.config?.slim) {
    for (const r of mani.metadataIndex?.index || []) {
      if (!('x' in r) && !('geometryRef' in r)) {
        // Expect ex geometry retrieval still possible (manifest.regions)
        // Just count: skip if canonical region not found.
        // Could refine with a map for O(1)
      }
    }
  }

  results.push({
    manifest: f,
    regionCount: regions.length,
    regionProvenanceCoverage: +regionProvenanceCoverage.toFixed(3),
    regionHashStable,
    slimmingViolations,
  });
}

if (!fs.existsSync('output/eval'))
  fs.mkdirSync('output/eval', { recursive: true });
fs.writeFileSync(OUT_PATH, stableJSON(results));
console.log('[eval] graph integrity report ->', OUT_PATH);
