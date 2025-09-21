// tests/global-crop-blur.test.mjs
// Smoke test for /global/crop with blur=1/0
import http from 'http';
import assert from 'assert';

process.env.PORT = process.env.PORT || '3010';
await import('../src/viewer/InteractiveViewerServer.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function get(pathname) {
  const port = process.env.PORT || 3010;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}
function post(pathname, body, contentType = 'application/json') {
  const port = process.env.PORT || 3010;
  const opts = {
    hostname: '127.0.0.1',
    port,
    path: pathname,
    method: 'POST',
    headers: { 'Content-Type': contentType },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: data }),
      );
    });
    req.on('error', reject);
    req.write(body || '');
    req.end();
  });
}

// Load sources
const imgResp = await get('/images.json');
assert.strictEqual(imgResp.status, 200, '/images.json should be 200');
const images = JSON.parse(imgResp.body.toString('utf8'));
const sources = images
  .filter((x) => x.hasManifest && x.jsonPath)
  .slice(0, 2)
  .map((x) => x.jsonPath);
assert.ok(sources.length >= 1, 'Need at least one manifest');
const loadResp = await post('/global/load', JSON.stringify({ sources }));
assert.strictEqual(loadResp.status, 200, '/global/load should be 200');

// Find a region URI likely to have a boundary
let rows = [];
const md = 'http://example.org/metadata#';
const q = `SELECT ?r WHERE { ?r <${md}tags> ?t } LIMIT 1`;
const qResp = await post('/global/sparql', q, 'text/plain');
assert.strictEqual(qResp.status, 200, '/global/sparql should be 200');
try {
  rows = JSON.parse(qResp.body);
} catch {
  rows = [];
}

let candidate = rows.find((r) => r.r)?.r;
if (!candidate) {
  // fallback: generic subjects then resolve via /global/regions
  const q2 = 'SELECT ?r WHERE { ?r ?p ?o } LIMIT 10';
  const r2 = await post('/global/sparql', q2, 'text/plain');
  const arr = JSON.parse(r2.body);
  const uris = arr.map((x) => x.r).filter(Boolean);
  const reg = await post('/global/regions', JSON.stringify({ uris }));
  const { regions } = JSON.parse(reg.body);
  candidate = regions?.[0]?.metadata?.uri || null;
}
assert.ok(candidate, 'Need at least one region URI');

// Crop with blur=1 and blur=0
const c1 = await get(
  `/global/crop?uri=${encodeURIComponent(candidate)}&size=120&blur=1`,
);
assert.strictEqual(c1.status, 200, 'crop blur=1 should be 200');
assert.ok(
  /image\/png/.test(c1.headers['content-type'] || ''),
  'content-type png',
);
assert.ok(c1.body.length > 100, 'non-empty image');

const c0 = await get(
  `/global/crop?uri=${encodeURIComponent(candidate)}&size=120&blur=0`,
);
assert.strictEqual(c0.status, 200, 'crop blur=0 should be 200');
assert.ok(
  /image\/png/.test(c0.headers['content-type'] || ''),
  'content-type png',
);
assert.ok(c0.body.length > 100, 'non-empty image');

console.log('/global/crop blur on/off smoke test passed');
process.exit(0);
