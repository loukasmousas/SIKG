/**
 * eval-helpers.mjs
 * Purpose: Utility helpers for evaluation scripts (manifest loading, stable JSON,
 * region normalization, hashing helpers, small timers).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

export function loadManifest(p) {
  const txt = fs.readFileSync(p, 'utf-8');
  return JSON.parse(txt);
}

export function stableJSON(obj) {
  return JSON.stringify(sortObj(obj), null, 2);
}
function sortObj(v) {
  if (Array.isArray(v)) return v.map(sortObj);
  if (v && typeof v === 'object') {
    return Object.keys(v)
      .sort()
      .reduce((a, k) => {
        a[k] = sortObj(v[k]);
        return a;
      }, {});
  }
  return v;
}

export function hashRegions(regions) {
  const norm = regions
    .map((r) => ({
      id: r.id,
      x: r.ex?.x,
      y: r.ex?.y,
      w: r.ex?.w,
      h: r.ex?.h,
      uri: r.metadata?.uri || r.md?.uri,
      class: r.md?.classLabel || r.ex?.classLabel,
    }))
    .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
  return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
}

export function computeIoU(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union ? inter / union : 0;
}

export async function computeHighFreqEnergy(buffer, region) {
  // Placeholder: expect buffer = raw RGBA, region = {x,y,w,h,width,height}
  // Simple gradient magnitude sum.
  const { data, width, height } = buffer; // allow sharp metadata-like object
  let energy = 0;
  const { x, y, w, h } = region;
  for (let yy = y + 1; yy < Math.min(y + h - 1, height - 1); yy++) {
    for (let xx = x + 1; xx < Math.min(x + w - 1, width - 1); xx++) {
      const idx = (yy * width + xx) * 4;
      const gx = data[idx - 4] - data[idx + 4];
      const gy = data[idx - width * 4] - data[idx + width * 4];
      energy += Math.abs(gx) + Math.abs(gy);
    }
  }
  return energy;
}

export async function timeStage(label, fn, acc) {
  const t0 = process.hrtime.bigint();
  const r = await fn();
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  if (acc) acc.push({ label, ms });
  return r;
}

export function hashFile(pathLike) {
  const buf = fs.readFileSync(pathLike);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Normalize regions from either legacy manifest.regions or regionManager.regions with boundary
export function getRegions(manifest) {
  if (!manifest) return [];
  const out = [];
  const src =
    Array.isArray(manifest.regions) && manifest.regions.length
      ? manifest.regions
      : manifest.regionManager?.regions || [];
  for (const r of src) {
    if (!r) continue;
    let x, y, w, h;
    if (r.ex && r.ex.x != null) {
      ({ x, y, w, h } = r.ex);
    } else if (r.boundary) {
      x = r.boundary.x1;
      y = r.boundary.y1;
      w = r.boundary.x2 - r.boundary.x1;
      h = r.boundary.y2 - r.boundary.y1;
    }
    // Basic provenance normalization
    const provenance = { ...(r.provenance || {}) };
    if (!provenance.detectedBy && r.metadata?.detectedBy)
      provenance.detectedBy = r.metadata.detectedBy;
    if (!provenance.mergedFrom && r.metadata?.mergedFrom)
      provenance.mergedFrom = r.metadata.mergedFrom;
    out.push({
      id: r.id,
      ex: {
        x,
        y,
        w,
        h,
        confidence: r.ex?.confidence ?? r.metadata?.confidence,
      },
      md: { classLabel: r.md?.classLabel ?? r.metadata?.classLabel },
      metadata: r.metadata || r.md || {},
      provenance,
      relationships: r.relationships || null,
    });
  }
  // Augment with mergedFrom by scanning RDF triples if not already present
  try {
    const RDFS = manifest.metadataIndex?.index || [];
    if (RDFS.length) {
      // Map uri -> region record
      const byUri = new Map();
      for (const r of out) {
        const uri = r.metadata?.uri;
        if (uri) byUri.set(uri, r);
      }
      const MERGED_PRED = '<http://example.org/mergedFrom>';
      for (const entry of RDFS) {
        const rdf = entry.rdf;
        if (!rdf || typeof rdf !== 'string') continue;
        if (rdf.includes('mergedFrom')) {
          // Split into statements at '.' boundaries
          const stmts = rdf
            .split(/\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          for (const st of stmts) {
            if (!st.includes(MERGED_PRED)) continue;
            // Pattern: <target> <http://example.org/mergedFrom> <src>
            const match = st.match(
              /<(uri:[^>]+)>\s+<http:\/\/example.org\/mergedFrom>\s+<([^>]+)>/,
            );
            if (match) {
              const [, target, src] = match;
              const region = byUri.get(target);
              if (region) {
                if (!region.provenance.mergedFrom)
                  region.provenance.mergedFrom = [];
                if (!region.provenance.mergedFrom.includes(src))
                  region.provenance.mergedFrom.push(src);
              }
            }
          }
        }
      }
    }
  } catch {
    /* ignore parse errors */
  }
  return out;
}
