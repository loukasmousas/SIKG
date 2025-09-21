import path from 'node:path';
import { loadManifest, getRegions } from './util/eval-helpers.mjs';
import { computeRelationsPure } from '../src/common/spatial-links.js';

const manifestFile = process.argv[2];
if (!manifestFile) {
  console.error(
    'usage: node tests/dump-relations.mjs <output/<manifest>.json> [limit]',
  );
  process.exit(1);
}
const limit = Number(process.argv[3] || '50');
const p = path.resolve(manifestFile);
const mani = loadManifest(p);
const regs = getRegions(mani);
const rels = computeRelationsPure(
  regs.map((r) => ({
    id: r.id,
    boundary: {
      x1: r.ex.x,
      y1: r.ex.y,
      x2: r.ex.x + r.ex.w,
      y2: r.ex.y + r.ex.h,
    },
  })),
);
const simplified = rels.slice(0, limit).map((r) => ({
  subject: r.source,
  predicate: r.predicate,
  object: r.target,
}));
console.log(
  JSON.stringify(
    { manifest: path.basename(p), count: rels.length, sample: simplified },
    null,
    2,
  ),
);
