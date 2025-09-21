// Summarize StageTimer JSONL logs into per-stage median and p95 latencies per flow.
// Output: output/eval/performance_summary.json

import fs from 'fs/promises';
import path from 'path';

const LOG = 'output/eval/performance_log.jsonl';
const OUT = 'output/eval/performance_summary.json';

function quantile(arr, q) {
  if (!arr.length) return 0;
  const pos = (arr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return arr[base] + (arr[base + 1] - arr[base]) * rest || arr[base];
}

function groupByStages(entries) {
  const by = {};
  for (const e of entries) {
    const flow = e.context?.flow || 'unknown';
    by[flow] ||= {};
    for (const s of e.stages || []) {
      by[flow][s.label] ||= [];
      by[flow][s.label].push(s.deltaMs);
    }
    by[flow].total ||= [];
    by[flow].total.push(e.totalMs);
    by[flow].peakRSS ||= [];
    if (typeof e.peakRSSMB === 'number') by[flow].peakRSS.push(e.peakRSSMB);
  }
  return by;
}

async function main() {
  try {
    const raw = await fs.readFile(LOG, 'utf8');
    const entries = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    // sort latencies for stable quantiles
    const by = groupByStages(entries);
    const summary = {};
    for (const [flow, stages] of Object.entries(by)) {
      summary[flow] = {};
      for (const [label, arr] of Object.entries(stages)) {
        const xs = arr.slice().sort((a, b) => a - b);
        summary[flow][label] = {
          n: xs.length,
          p50: +quantile(xs, 0.5).toFixed(2),
          p95: +quantile(xs, 0.95).toFixed(2),
          mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2),
        };
      }
      if (stages.peakRSS) {
        const mem = stages.peakRSS.slice().sort((a, b) => a - b);
        summary[flow].peakRSSMB = {
          n: mem.length,
          p50: +quantile(mem, 0.5).toFixed(2),
          p95: +quantile(mem, 0.95).toFixed(2),
          mean: +(mem.reduce((a, b) => a + b, 0) / mem.length).toFixed(2),
        };
      }
    }
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(summary, null, 2));
    console.log('Wrote', OUT);
  } catch (e) {
    console.error('performance eval failed:', e.message);
    process.exit(1);
  }
}

main();
