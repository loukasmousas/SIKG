import fs from 'node:fs';
import crypto from 'node:crypto';
import { Parser } from 'n3';
import { getRegions } from './util/eval-helpers.mjs';

function hashManifest(manifestPath) {
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  const regions = getRegions(m);
  const orderedRegions = regions
    .slice()
    .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')))
    .map((r) => [
      r.id,
      r.ex?.x,
      r.ex?.y,
      r.ex?.w,
      r.ex?.h,
      r.md?.classLabel || r.metadata?.classLabel,
    ]);
  const relations = (m.relations || [])
    .map((r) => [r.source, r.predicate, r.target])
    .sort();
  // Triple-level hash: try to read RDF quads from metadataIndex store JSON when present
  let tripleHash = null;
  try {
    const idx = m.metadataIndex;
    if (idx?.store && Array.isArray(idx.store)) {
      // store may already be an array of quads
      const quads = idx.store;
      const tuples = quads
        .map((q) => [
          q.subject?.value || String(q.subject || ''),
          q.predicate?.value || String(q.predicate || ''),
          q.object?.value || String(q.object || ''),
          q.graph?.value || String(q.graph || ''),
        ])
        .map((t) => t.join('\u0001'))
        .sort();
      tripleHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(tuples))
        .digest('hex');
    } else if (idx?.index) {
      // index may be an object map or array; collect rdf strings
      const entries = Array.isArray(idx.index)
        ? idx.index
        : Object.values(idx.index);
      const rdfSnippets = entries
        .map((e) => (typeof e.rdf === 'string' ? e.rdf.trim() : ''))
        .filter(Boolean)
        .map((s) => s.replace(/\s+/g, ' ').trim())
        .sort();
      if (rdfSnippets.length) {
        tripleHash = crypto
          .createHash('sha256')
          .update(JSON.stringify(rdfSnippets))
          .digest('hex');
      }
    } else if (typeof idx?.rdf === 'string' && idx.rdf.trim().length) {
      // Preferred path: hash parsed quads from consolidated Turtle string
      try {
        const parser = new Parser();
        const quads = parser.parse(idx.rdf);
        const tuples = quads
          .map((q) => [
            q.subject?.value || String(q.subject || ''),
            q.predicate?.value || String(q.predicate || ''),
            q.object?.value || String(q.object || ''),
            q.graph?.value || String(q.graph || ''),
          ])
          .map((t) => t.join('\u0001'))
          .sort();
        tripleHash = crypto
          .createHash('sha256')
          .update(JSON.stringify(tuples))
          .digest('hex');
      } catch {
        // ignore RDF parse error
      }
    }
  } catch {
    // ignore
  }
  const regionRelationHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ orderedRegions, relations }))
    .digest('hex');
  return { regionRelationHash, tripleHash };
}

const runs = process.argv[2] ? parseInt(process.argv[2], 10) : 3;
const targetManifest = process.argv[3];
if (!targetManifest) {
  console.error(
    'Usage: node tests/eval-reproducibility.mjs <runs> <manifestPath>',
  );
  process.exit(1);
}

const hashes = [];
const tripleHashes = [];
for (let i = 0; i < runs; i++) {
  const { regionRelationHash, tripleHash } = hashManifest(targetManifest);
  hashes.push(regionRelationHash);
  if (tripleHash) tripleHashes.push(tripleHash);
}
const unique = new Set(hashes);
const uniqueTriples = new Set(tripleHashes);
const out = {
  runs,
  uniqueHashes: unique.size,
  regionRelationHashes: hashes,
  tripleHash: tripleHashes.length ? tripleHashes[0] : null,
  uniqueTripleHashes: tripleHashes.length ? uniqueTriples.size : null,
};
if (!fs.existsSync('output/eval'))
  fs.mkdirSync('output/eval', { recursive: true });
fs.writeFileSync(
  'output/eval/reproducibility.json',
  JSON.stringify(out, null, 2),
);
console.log(
  '[eval] reproducibility report -> output/eval/reproducibility.json',
);
