import fs from 'node:fs';
import path from 'node:path';
import { loadManifest, stableJSON, getRegions } from './util/eval-helpers.mjs';

const INPUT_DIR = 'output';
const OUT_PATH = 'output/eval/transformation_fidelity.json';
const REPORT = [];

function parityPercent(a, b) {
  return b === 0 ? (a === 0 ? 0 : 100) : ((a - b) / b) * 100;
}

for (const file of fs
  .readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.json'))) {
  if (file.endsWith('.raw-model.json')) continue; // skip raw dumps themselves
  const manifestPath = path.join(INPUT_DIR, file);
  const manifest = loadManifest(manifestPath);
  const rawPath = manifestPath.replace('.json', '.raw-model.json');
  let raw = null;
  if (fs.existsSync(rawPath)) {
    try {
      raw = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    } catch {
      raw = null;
    }
  }

  const rawRegions = raw ? raw.detections.length : null;
  const regions = getRegions(manifest);
  const storedRegions = regions.length;

  // per-class counts
  const classCountRaw = {};
  if (raw) {
    for (const d of raw.detections) {
      classCountRaw[d.class] = (classCountRaw[d.class] || 0) + 1;
    }
  }
  const classCountStored = {};
  for (const r of regions) {
    const label =
      r.md?.classLabel || r.metadata?.classLabel || r.ex?.classLabel;
    if (label) classCountStored[label] = (classCountStored[label] || 0) + 1;
  }

  // confidence MAE & max diff (matching by index or simple greedy within same class & IoU)
  const diffs = [];
  if (raw) {
    for (let i = 0; i < Math.min(raw.detections.length, regions.length); i++) {
      const rd = raw.detections[i];
      const rg = regions[i];
      if (!rg || !rd) continue;
      if (rd.class === (rg.md?.classLabel || rg.metadata?.classLabel)) {
        const diff = Math.abs(
          rd.score - (rg.ex?.confidence ?? rg.metadata?.confidence ?? 0),
        );
        diffs.push(diff);
      }
    }
  }
  const mae = diffs.length
    ? diffs.reduce((a, b) => a + b, 0) / diffs.length
    : 0;
  const maxDiff = diffs.length ? Math.max(...diffs) : 0;

  REPORT.push({
    image: file,
    regionCountRaw: rawRegions,
    regionCountStored: storedRegions,
    regionCountParityPct:
      rawRegions == null
        ? null
        : parityPercent(rawRegions, storedRegions).toFixed(2),
    maeConfidence: raw ? +mae.toFixed(4) : null,
    maxConfidenceDiff: raw ? +maxDiff.toFixed(4) : null,
    unmappedLabels: raw
      ? raw.detections
          .filter((d) => !classCountStored[d.class])
          .map((d) => d.class)
      : [],
    perClassRecall: raw
      ? Object.fromEntries(
          Object.entries(classCountRaw).map(([cls, rawCnt]) => {
            const storedCnt = classCountStored[cls] || 0;
            return [cls, +(storedCnt / rawCnt).toFixed(3)];
          }),
        )
      : null,
  });
}

if (!fs.existsSync('output/eval'))
  fs.mkdirSync('output/eval', { recursive: true });
fs.writeFileSync(OUT_PATH, stableJSON(REPORT));
console.log('[eval] transformation fidelity report ->', OUT_PATH);
