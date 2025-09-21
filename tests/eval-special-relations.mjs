import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, stableJSON, getRegions } from './util/eval-helpers.mjs';
import { computeRelationsPure } from '../src/common/spatial-links.js';

// Real-data spatial relation enumeration. Output counts per manifest and global totals.
const perManifest = [];
let globalCounts = { contains: 0, inside: 0, overlaps: 0, near: 0 };
let globalRegions = 0;
const globalParticipating = new Set();
for (const f of fs.readdirSync('output').filter((f) => f.endsWith('.json'))) {
  try {
    const mani = loadManifest(path.join('output', f));
    const regs = getRegions(mani);
    if (!regs.length) continue;
    const produced = computeRelationsPure(
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
    const counts = { contains: 0, inside: 0, overlaps: 0, near: 0 };
    const participating = new Set();
    for (const rel of produced) {
      if (counts[rel.predicate] != null) counts[rel.predicate]++;
      if (rel.source) participating.add(rel.source);
      if (rel.target) participating.add(rel.target);
    }
    const totalRelations = Object.values(counts).reduce((a, b) => a + b, 0);
    const cov = regs.length ? (participating.size / regs.length) * 100 : 0;
    perManifest.push({
      manifest: f,
      ...counts,
      totalRelations,
      regionCount: regs.length,
      regionsParticipating: participating.size,
      relationCoveragePct: +cov.toFixed(2),
    });
    for (const k of Object.keys(globalCounts)) globalCounts[k] += counts[k];
    globalRegions += regs.length;
    for (const id of participating) globalParticipating.add(id);
  } catch {
    /* ignore */
  }
}

const summary = {
  perManifest,
  global: {
    ...globalCounts,
    regionCount: globalRegions,
    regionsParticipating: globalParticipating.size,
    relationCoveragePct: globalRegions
      ? +((globalParticipating.size / globalRegions) * 100).toFixed(2)
      : 0,
  },
};
// Compute precision/recall/F1 if a spatial gold is present
try {
  const goldPath = 'evaluation/spatial/gold.json';
  if (fs.existsSync(goldPath)) {
    const gold = JSON.parse(fs.readFileSync(goldPath, 'utf-8'));
    // gold format expected: { relations: [{subject, predicate, object}], manifests?: ["file.json"], options?: { ...computeRelationsPure thresholds... } }
    const goldSet = new Set(
      (gold.relations || [])
        .map((r) => `${r.subject}|${r.predicate}|${r.object}`)
        .filter(Boolean),
    );
    const manifestFilter = Array.isArray(gold.manifests)
      ? new Set(gold.manifests)
      : null;
    const relOpts = gold.options || {};
    // Combine produced relations across manifests via recomputation above
    const produced = new Set();
    for (const f of fs
      .readdirSync('output')
      .filter((f) => f.endsWith('.json'))) {
      if (manifestFilter && !manifestFilter.has(f)) continue;
      try {
        const mani = loadManifest(path.join('output', f));
        const regs = getRegions(mani);
        if (!regs.length) continue;
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
          relOpts,
        );
        for (const r of rels)
          produced.add(`${r.source}|${r.predicate}|${r.target}`);
      } catch {
        /* ignore */
      }
    }
    let tp = 0;
    for (const t of produced) if (goldSet.has(t)) tp++;
    const fp = Math.max(0, produced.size - tp);
    const fn = Math.max(0, goldSet.size - tp);
    const prec = produced.size ? tp / produced.size : 0;
    const rec = goldSet.size ? tp / goldSet.size : 0;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    // Per-predicate breakdown
    const preds = ['contains', 'inside', 'overlaps', 'near'];
    const byPredicate = {};
    for (const p of preds) {
      const gP = new Set(
        (gold.relations || [])
          .filter((r) => r.predicate === p)
          .map((r) => `${r.subject}|${r.predicate}|${r.object}`),
      );
      const prP = new Set([...produced].filter((s) => s.split('|')[1] === p));
      let tpP = 0;
      for (const t of prP) if (gP.has(t)) tpP++;
      const fpP = Math.max(0, prP.size - tpP);
      const fnP = Math.max(0, gP.size - tpP);
      const pr = prP.size ? tpP / prP.size : 0;
      const rc = gP.size ? tpP / gP.size : 0;
      const f = pr + rc ? (2 * pr * rc) / (pr + rc) : 0;
      byPredicate[p] = {
        goldCount: gP.size,
        producedCount: prP.size,
        tp: tpP,
        fp: fpP,
        fn: fnP,
        precision: +pr.toFixed(3),
        recall: +rc.toFixed(3),
        f1: +f.toFixed(3),
      };
    }
    summary.gold = {
      goldCount: goldSet.size,
      producedCount: produced.size,
      tp,
      fp,
      fn,
      precision: +prec.toFixed(3),
      recall: +rec.toFixed(3),
      f1: +f1.toFixed(3),
      byPredicate,
    };
  }
} catch {
  /* ignore optional gold */
}
if (!fs.existsSync('output/eval'))
  fs.mkdirSync('output/eval', { recursive: true });
fs.writeFileSync('output/eval/spatial_relations.json', stableJSON(summary));
console.log(
  '[eval] spatial relations (real) report -> output/eval/spatial_relations.json',
);
