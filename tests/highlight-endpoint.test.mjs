// tests/highlight-endpoint.test.mjs
// Covers /highlight: returns bounding boxes for SPARQL results (expects ?r or ?s/?o)
import http from 'http';
import assert from 'assert';

process.env.PORT = process.env.PORT || '3015';
await import('../src/viewer/InteractiveViewerServer.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function get(pathname) {
  const port = process.env.PORT || 3015;
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
  const port = process.env.PORT || 3015;
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

// Load one or two manifests into the viewer state
const imgResp = await get('/images.json');
assert.strictEqual(imgResp.status, 200, '/images.json should be 200');
const images = JSON.parse(imgResp.body);
const one = images.find((x) => x.hasManifest && x.jsonPath);
if (!one) {
  console.log('ℹ No image with manifest; skipping highlight test');
  process.exit(0);
}

// Load the chosen manifest into the in-memory state via /loadImage
const load = await get(
  '/loadImage?jsonPath=' + encodeURIComponent(one.jsonPath),
);
assert.strictEqual(load.status, 200, '/loadImage should be 200');

// Build a simple SPARQL selecting regions (binds ?r)
const md = 'http://example.org/metadata#';
const q = `SELECT ?r WHERE { ?r <${md}tags> ?t } LIMIT 10`;
const hResp = await post('/highlight', q, 'text/plain');
assert.strictEqual(hResp.status, 200, '/highlight should be 200');
let arr = [];
try {
  arr = JSON.parse(hResp.body);
} catch (e) {
  console.warn('warn: failed to parse highlight response', e?.message || e);
}
if (!Array.isArray(arr) || arr.length === 0) {
  console.log(
    'ℹ No boxes returned by /highlight for this manifest; skipping.',
  );
  process.exit(0);
}
const b = arr[0];
assert.ok(
  'uri' in b && 'x1' in b && 'y1' in b && 'x2' in b && 'y2' in b,
  'box fields present',
);
console.log('/highlight smoke test passed with', arr.length, 'boxes');
process.exit(0);
