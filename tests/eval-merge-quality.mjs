import fs from 'node:fs';
import path from 'node:path';
import {
  computeIoU,
  loadManifest,
  stableJSON,
  getRegions,
} from './util/eval-helpers.mjs';

const INPUT_DIR = 'output';
const IOU_THRESHOLD = 0.5;
const OUT_PATH = 'output/eval/merge_quality.json';
const report = [];

function bbox(r) {
  return { x: r.ex.x, y: r.ex.y, w: r.ex.w, h: r.ex.h };
}

for (const f of fs.readdirSync(INPUT_DIR).filter((f) => f.endsWith('.json'))) {
  if (f.endsWith('.raw-model.json')) continue; // skip raw dumps
  const mani = loadManifest(path.join(INPUT_DIR, f));
  const regions = getRegions(mani);
  if (!regions.length) continue;
  const mergedFrom = regions.filter((r) => r.provenance?.mergedFrom);
  const mergeProvenanceRate = mergedFrom.length
    ? mergedFrom.length / regions.length
    : 0;

  // Estimate duplicate pairs prior to merge (if original tile snapshots stored)
  // If not stored: approximate by scanning final regions for IoU >= threshold & same class (should be near-zero if merges worked).
  let residualDuplicates = 0;
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const ri = regions[i],
        rj = regions[j];
      if (ri.md?.classLabel === rj.md?.classLabel) {
        const iou = computeIoU(bbox(ri), bbox(rj));
        if (iou >= IOU_THRESHOLD) residualDuplicates++;
      }
    }
  }

  // sharePreds filtering heuristic: count relationships present on regions flagged with propagatedFrom tag
  let propagatedEdges = 0;
  let totalEdges = 0;
  for (const r of regions) {
    const rels = Array.isArray(r.relationships) ? r.relationships : [];
    for (const rel of rels) {
      totalEdges++;
      if (rel?.metadata?.propagatedFrom) propagatedEdges++;
    }
  }
  report.push({
    manifest: f,
    totalRegions: regions.length,
    mergeProvenanceRate: +mergeProvenanceRate.toFixed(3),
    residualDuplicates,
    propagatedEdgeRatio: totalEdges
      ? +(propagatedEdges / totalEdges).toFixed(3)
      : null,
  });
}

if (!fs.existsSync('output/eval'))
  fs.mkdirSync('output/eval', { recursive: true });
fs.writeFileSync(OUT_PATH, stableJSON(report));
console.log('[eval] merge quality report ->', OUT_PATH);
