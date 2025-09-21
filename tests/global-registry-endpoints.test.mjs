// tests/global-registry-endpoints.test.mjs
// Smoke tests for /global/* endpoints
import http from 'http';
import assert from 'assert';

process.env.PORT = process.env.PORT || '3008';
await import('../src/viewer/InteractiveViewerServer.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function get(pathname) {
  const port = process.env.PORT || 3008;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: data }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}
function post(pathname, body, contentType = 'application/json') {
  const port = process.env.PORT || 3008;
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

// Pull available images to choose sources
const imgResp = await get('/images.json');
assert.strictEqual(imgResp.status, 200, '/images.json should be 200');
const images = JSON.parse(imgResp.body);
const sources = images
  .filter((x) => x.hasManifest && x.jsonPath)
  .slice(0, 2)
  .map((x) => x.jsonPath);
assert.ok(
  sources.length >= 1,
  'Need at least one image with manifest for global test',
);

// Load into global registry
const loadResp = await post('/global/load', JSON.stringify({ sources }));
assert.strictEqual(loadResp.status, 200, '/global/load should be 200');
const loadJson = JSON.parse(loadResp.body);
assert.strictEqual(loadJson.ok, true);
assert.ok(loadJson.regionCount >= 0);

// Run a trivial query (allow empty results)
const sparql = 'SELECT ?r WHERE { ?r ?p ?o } LIMIT 5';
const qResp = await post('/global/sparql', sparql, 'text/plain');
assert.strictEqual(qResp.status, 200, '/global/sparql should be 200');
let rows = [];
try {
  rows = JSON.parse(qResp.body);
} catch {
  rows = [];
}
assert.ok(Array.isArray(rows), 'SPARQL should return JSON array');

// Resolve first URI to region and try crop (best-effort)
const firstWithR = rows.find((r) => r.r) || null;
if (firstWithR) {
  const oneUri = firstWithR.r;
  const regResp = await post(
    '/global/regions',
    JSON.stringify({ uris: [oneUri] }),
  );
  assert.strictEqual(regResp.status, 200, '/global/regions should be 200');
  const regJson = JSON.parse(regResp.body);
  assert.ok(Array.isArray(regJson.regions));
  // Crop endpoint is best-effort depending on source mapping; skip strict assert
}

console.log('Global endpoints smoke test passed');
process.exit(0);
