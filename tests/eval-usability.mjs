import fs from 'node:fs';

const IN = 'output/eval/usability_events.jsonl';
const OUT = 'output/eval/usability_summary.json';

function quantile(arr, q) {
  if (!arr.length) return 0;
  const xs = arr.slice().sort((a, b) => a - b);
  const pos = (xs.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return xs[base] + (xs[base + 1] - xs[base]) * rest || xs[base];
}

try {
  if (!fs.existsSync(IN)) throw new Error('no events');
  const lines = fs.readFileSync(IN, 'utf-8').trim().split('\n').filter(Boolean);
  const events = [];
  for (const l of lines) {
    try {
      events.push(JSON.parse(l));
    } catch (_) {
      // skip malformed line
    }
  }
  const byType = new Map();
  for (const e of events) {
    const t = e.type || 'unknown';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(e);
  }
  // Sort each bucket by timestamp for composed calculations
  for (const arr of byType.values())
    arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const summary = {};
  for (const [type, arr] of byType) {
    const durs = arr
      .map((e) => {
        const top = Number(e.durationMs);
        if (Number.isFinite(top) && top >= 0) return top;
        const nested = Number(e?.detail?.durationMs);
        if (Number.isFinite(nested) && nested >= 0) return nested;
        return 0;
      })
      .filter((x) => Number.isFinite(x) && x >= 0);
    summary[type] = {
      n: arr.length,
      withDuration: durs.length,
      p50: +quantile(durs, 0.5).toFixed(1),
      p95: +quantile(durs, 0.95).toFixed(1),
      mean: durs.length
        ? +(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(1)
        : 0,
    };
  }

  // Composed durations
  const composed = {};
  // query_start -> query_end
  {
    const starts = (byType.get('query_start') || [])
      .map((e) => e.ts)
      .filter(Boolean);
    const ends = (byType.get('query_end') || [])
      .map((e) => e.ts)
      .filter(Boolean);
    const paired = [];
    let si = 0;
    for (const et of ends) {
      // take the latest start before this end
      while (si < starts.length && starts[si] <= et) si++;
      const startTs = starts[si - 1];
      if (startTs != null && startTs <= et) paired.push(et - startTs);
    }
    const ms = paired
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x >= 0);
    composed.query = {
      n: ms.length,
      p50: +quantile(ms, 0.5).toFixed(1),
      p95: +quantile(ms, 0.95).toFixed(1),
      mean: ms.length
        ? +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)
        : 0,
      note: 'query_start→query_end (ms) by timestamp pairing',
    };
  }

  // editor_open -> save_end
  {
    const opens = (byType.get('editor_open') || [])
      .map((e) => e.ts)
      .filter(Boolean);
    const saves = (byType.get('save_end') || [])
      .map((e) => e.ts)
      .filter(Boolean);
    const paired = [];
    let oi = 0;
    for (const st of saves) {
      while (oi < opens.length && opens[oi] <= st) oi++;
      const openTs = opens[oi - 1];
      if (openTs != null && openTs <= st) paired.push(st - openTs);
    }
    const ms = paired
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x >= 0);
    composed.editorOpenToSave = {
      n: ms.length,
      p50: +quantile(ms, 0.5).toFixed(1),
      p95: +quantile(ms, 0.95).toFixed(1),
      mean: ms.length
        ? +(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)
        : 0,
      note: 'editor_open→save_end (ms) by timestamp pairing',
    };
  }

  // Emit combined summary
  const outSummary = { events: summary, composed };
  fs.writeFileSync(OUT, JSON.stringify(outSummary, null, 2));
  console.log('[eval] usability summary ->', OUT);
} catch (_e) {
  // Produce an empty summary to keep pipelines stable
  fs.mkdirSync('output/eval', { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify({ note: 'no usability events' }, null, 2),
  );
  console.log('[eval] usability summary ->', OUT, '(no events)');
}
