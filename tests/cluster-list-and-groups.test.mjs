// tests/cluster-list-and-groups.test.mjs
// Covers /global/clusters grouping and /global/cluster/list listing
import http from 'http';
import assert from 'assert';

process.env.PORT = process.env.PORT || '3014';
await import('../src/viewer/InteractiveViewerServer.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function get(pathname) {
  const port = process.env.PORT || 3014;
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
  const port = process.env.PORT || 3014;
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

// Discover sources
const imgResp = await get('/images.json');
assert.strictEqual(imgResp.status, 200, '/images.json should be 200');
const images = JSON.parse(imgResp.body);
const sources = images
  .filter((x) => x.hasManifest && x.jsonPath)
  .slice(0, 2)
  .map((x) => x.jsonPath);
if (sources.length < 1) {
  console.log('ℹ No images with manifest; skipping cluster list/groups test.');
  process.exit(0);
}

// Load into global registry
const loadResp = await post('/global/load', JSON.stringify({ sources }));
assert.strictEqual(loadResp.status, 200, '/global/load should be 200');

// Find a few region URIs
const md = 'http://example.org/metadata#';
const q = `SELECT ?r WHERE { ?r <${md}tags> ?t } LIMIT 20`;
const qResp = await post('/global/sparql', q, 'text/plain');
assert.strictEqual(qResp.status, 200, '/global/sparql should be 200');
let uris = [];
try {
  uris = JSON.parse(qResp.body)
    .map((x) => x.r)
    .filter(Boolean);
} catch (e) {
  console.warn('warn: failed to parse SPARQL rows', e?.message || e);
}

// Resolve to region objects to filter to actual regions
const regResp = await post('/global/regions', JSON.stringify({ uris }));
assert.strictEqual(regResp.status, 200, '/global/regions should be 200');
const regions = JSON.parse(regResp.body).regions || [];
uris = regions.map((r) => r?.metadata?.uri).filter(Boolean);
if (uris.length < 3) {
  console.log(
    'ℹ Not enough regions to run cluster list/groups test; skipping.',
  );
  process.exit(0);
}

// Create a cluster using two URIs
const mk = await post(
  '/global/cluster',
  JSON.stringify({
    uris: uris.slice(0, 2),
    name: 'DDVehicles',
    propagate: false,
  }),
);
assert.strictEqual(mk.status, 200, '/global/cluster should be 200');
const clusterIri = JSON.parse(mk.body).cluster;
assert.ok(clusterIri, 'cluster created');

// Group a set of URIs using /global/clusters
const groupsResp = await post(
  '/global/clusters',
  JSON.stringify({ uris: uris.slice(0, 3) }),
);
assert.strictEqual(groupsResp.status, 200, '/global/clusters should be 200');
const groups = JSON.parse(groupsResp.body).groups || [];
assert.ok(Array.isArray(groups), 'groups should be an array');
assert.ok(groups.length >= 1, 'groups should be non-empty');
assert.ok(groups[0].id && Array.isArray(groups[0].uris), 'group shape');

// List clusters globally
const listResp = await get('/global/cluster/list');
assert.strictEqual(listResp.status, 200, '/global/cluster/list should be 200');
const list = JSON.parse(listResp.body).clusters || [];
assert.ok(Array.isArray(list), 'clusters should be array');
const found = list.some(
  (c) => c.iri === clusterIri && Array.isArray(c.members),
);
assert.ok(found, 'created cluster should appear in list');

console.log('Cluster list and groups endpoints smoke test passed');
process.exit(0);
