// perf-metrics.js
//
// Purpose: Lightweight stage timing with RSS snapshots. Appends JSONL entries to
// output/eval/performance_log.jsonl for downstream summarization (p50/p95/mean).
//
// Notes: Percentile metrics (p50/p95) are commonly used to track performance tails.
// See e.g. https://en.wikipedia.org/wiki/Percentile for definitions.

import fs from 'node:fs';
import path from 'node:path';

const METRICS_OUT = 'output/eval/performance_log.jsonl';

function ensureDirFor(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** StageTimer — capture stage durations and coarse memory snapshots */
export class StageTimer {
  constructor(context = {}) {
    this.context = context;
    this.stages = [];
    this.start = process.hrtime.bigint();
    this.last = this.start;
  }
  mark(label) {
    const now = process.hrtime.bigint();
    const deltaMs = Number(now - this.last) / 1e6;
    // capture lightweight RSS snapshot (MB) for coarse memory tracking
    const rssMB =
      Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100;
    this.stages.push({ label, deltaMs: +deltaMs.toFixed(3), rssMB });
    this.last = now;
    return deltaMs;
  }
  flush(extra = {}) {
    const totalMs = Number(process.hrtime.bigint() - this.start) / 1e6;
    const peakRSSMB = this.stages.reduce(
      (m, s) => (s.rssMB > m ? s.rssMB : m),
      0,
    );
    const entry = {
      ts: Date.now(),
      context: this.context,
      stages: this.stages,
      totalMs: +totalMs.toFixed(3),
      peakRSSMB,
      ...extra,
    };
    try {
      ensureDirFor(METRICS_OUT);
      fs.appendFileSync(METRICS_OUT, JSON.stringify(entry) + '\n');
    } catch (e) {
      // swallow to avoid crashing pipelines
      console.warn('[StageTimer] failed to write metrics:', e.message);
    }
    return entry;
  }
}
