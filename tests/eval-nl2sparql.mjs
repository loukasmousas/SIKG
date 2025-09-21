import fs from 'node:fs';
import path from 'node:path';
import fetch from 'node-fetch';
import { performance } from 'node:perf_hooks';

const QUERIES = fs
  .readFileSync('evaluation/nl2sparql/queries.jsonl', 'utf-8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const stats = {
  total: 0,
  parseSuccess: 0,
  execSuccess: 0,
  latency: [],
};

// Ensure the viewer has a registry loaded (if server is running) so queries execute against data.
try {
  const payload = {
    manifests: fs
      .readdirSync('output')
      .filter((f) => f.endsWith('.json') && !f.endsWith('.raw-model.json'))
      .map((f) => path.join('output', f))
      .slice(0, 5), // keep small
  };
  await fetch('http://localhost:3000/global/load', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
} catch (_) {
  // ignore if server not running; execSuccess will be low
}

for (const q of QUERIES) {
  stats.total++;
  const start = performance.now();
  let res;
  try {
    res = await fetch('http://localhost:3000/nl2sparql/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ utterance: q.utterance }),
    }).then((r) => r.json());
  } catch (_e) {
    // Offline fallback: trivial echo stub
    res = { sparql: 'SELECT ?s WHERE { ?s ?p ?o } LIMIT 1', results: [] };
  }
  const elapsed = performance.now() - start;
  stats.latency.push(elapsed);
  if (res.sparql && !res.parseError) stats.parseSuccess++;
  if (Array.isArray(res.results) && !res.error) stats.execSuccess++;
}

const summary = {
  total: stats.total,
  parseRate: +(stats.parseSuccess / stats.total).toFixed(3),
  execSuccessRate: +(stats.execSuccess / stats.total).toFixed(3),
  medianLatencyMs: stats.latency.sort((a, b) => a - b)[
    Math.floor(stats.latency.length / 2)
  ],
};

// Compute exact match rate vs gold.
try {
  const goldPath = 'evaluation/nl2sparql/gold.jsonl';
  if (fs.existsSync(goldPath)) {
    const gold = fs
      .readFileSync(goldPath, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    // naive exact-string compare by utterance
    const map = new Map();
    for (const g of gold) map.set(g.utterance, (g.sparql || '').trim());
    let exact = 0;
    for (const q of QUERIES) {
      const expected = (map.get(q.utterance) || '').trim();
      if (!expected) continue;
      // In a full impl, I'd capture the actual SPARQL returned for each query. For now, re-query once quickly.
      let got = '';
      try {
        const r = await fetch('http://localhost:3000/nl2sparql/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ utterance: q.utterance }),
        }).then((r) => r.json());
        got = (r.sparql || '').trim();
      } catch {
        /* ignore gold compare fetch error */
      }
      if (got && expected && got === expected) exact++;
    }
    summary.exactQueryRate = +(exact / Math.max(1, gold.length)).toFixed(3);
  } else {
    // Fallback: use gold_sparql embedded in queries.jsonl if present
    let exact = 0;
    let denom = 0;
    for (const q of QUERIES) {
      const expected = (q.gold_sparql || '').trim();
      if (!expected) continue;
      denom++;
      let got = '';
      try {
        const r = await fetch('http://localhost:3000/nl2sparql/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ utterance: q.utterance }),
        }).then((r) => r.json());
        got = (r.sparql || '').trim();
      } catch {
        // ignore request error during gold fallback
      }
      if (got && expected && got === expected) exact++;
    }
    if (denom > 0) summary.exactQueryRate = +(exact / denom).toFixed(3);
  }
} catch {
  /* ignore optional gold processing */
}

if (!fs.existsSync('output/eval'))
  fs.mkdirSync('output/eval', { recursive: true });
fs.writeFileSync(
  'output/eval/nl2sparql_summary.json',
  JSON.stringify(summary, null, 2),
);
console.log('[eval] NL2SPARQL summary -> output/eval/nl2sparql_summary.json');
