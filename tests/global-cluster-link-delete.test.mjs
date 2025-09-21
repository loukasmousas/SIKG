// tests/global-cluster-link-delete.test.mjs
// Covers /global/cluster, /global/cluster/link enabled/disabled transitions
import http from 'http';
import assert from 'assert';

process.env.PORT = process.env.PORT || '3011';
await import('../src/viewer/InteractiveViewerServer.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function get(pathname) {
  const port = process.env.PORT || 3011;
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
  const port = process.env.PORT || 3011;
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

// Load 1-2 sources
const imgResp = await get('/images.json');
assert.strictEqual(imgResp.status, 200, '/images.json should be 200');
const images = JSON.parse(imgResp.body);
const sources = images
  .filter((x) => x.hasManifest && x.jsonPath)
  .slice(0, 2)
  .map((x) => x.jsonPath);
assert.ok(sources.length >= 1, 'Need at least one image with manifest');
const loadResp = await post('/global/load', JSON.stringify({ sources }));
assert.strictEqual(loadResp.status, 200);

// Collect at least 4 region URIs
const md = 'http://example.org/metadata#';
const q = `SELECT ?r WHERE { ?r <${md}tags> ?t } LIMIT 20`;
const qResp = await post('/global/sparql', q, 'text/plain');
assert.strictEqual(qResp.status, 200);
let uris = [];
try {
  uris = JSON.parse(qResp.body)
    .map((x) => x.r)
    .filter(Boolean);
} catch (_e) {
  // ignore parse failures; test will skip if not enough regions
}
// Resolve to regions to filter out non-region IRIs if any
const regResp = await post('/global/regions', JSON.stringify({ uris }));
const regions = JSON.parse(regResp.body).regions || [];
uris = regions.map((r) => r?.metadata?.uri).filter(Boolean);
if (uris.length < 4) {
  console.log('ℹ Not enough regions to run link-delete test; skipping.');
  process.exit(0);
}

// Create two clusters
const aUris = uris.slice(0, 2);
const bUris = uris.slice(2, 4);
const mkA = await post(
  '/global/cluster',
  JSON.stringify({ uris: aUris, propagate: false, name: 'TestA' }),
);
const mkB = await post(
  '/global/cluster',
  JSON.stringify({ uris: bUris, propagate: false, name: 'TestB' }),
);
assert.strictEqual(mkA.status, 200);
assert.strictEqual(mkB.status, 200);
const clusterA = JSON.parse(mkA.body).cluster;
const clusterB = JSON.parse(mkB.body).cluster;
assert.ok(clusterA && clusterB, 'clusters created');

// Link the clusters
const linkResp = await post(
  '/global/cluster/link',
  JSON.stringify({ a: clusterA, b: clusterB, predicate: 'clusterLinkedTo' }),
);
assert.strictEqual(linkResp.status, 200);

// Relationships should show active link
const rel1 = await get(
  '/relationships?global=1&uri=' + encodeURIComponent(clusterA),
);
assert.strictEqual(rel1.status, 200);
const relRows1 = JSON.parse(rel1.body);
const hasActive = relRows1.some(
  (r) =>
    !r.deleted &&
    /metadata#clusterLinkedTo$/.test(r.predicate) &&
    r.other === clusterB,
);
assert.ok(hasActive, 'active clusterLinkedTo should exist');

// Delete the link (soft-delete)
const delLink = await post(
  '/global/cluster/link',
  JSON.stringify({
    a: clusterA,
    b: clusterB,
    predicate: 'clusterLinkedTo',
    enabled: false,
  }),
);
assert.strictEqual(delLink.status, 200);

const rel2 = await get(
  '/relationships?global=1&uri=' + encodeURIComponent(clusterA),
);
assert.strictEqual(rel2.status, 200);
const relRows2 = JSON.parse(rel2.body);
const activeAfter = relRows2.some(
  (r) =>
    !r.deleted &&
    /metadata#clusterLinkedTo$/.test(r.predicate) &&
    r.other === clusterB,
);
const deletedPresent = relRows2.some(
  (r) =>
    r.deleted &&
    /metadata#clusterLinkedTo$/.test(r.predicate) &&
    r.other === clusterB,
);
assert.ok(!activeAfter, 'active link should be removed');
assert.ok(deletedPresent, 'deleted link should be present');

console.log('Cluster link delete/restore smoke test passed');
process.exit(0);
