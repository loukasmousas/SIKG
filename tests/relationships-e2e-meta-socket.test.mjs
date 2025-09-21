// tests/relationships-e2e-meta-socket.test.mjs
// Minimal e2e: set name/description via socket and verify via /relationships
import assert from 'assert';
import { io as Client } from 'socket.io-client';
import http from 'http';

process.env.PORT = process.env.PORT || '3007';
const { default: _serverMod } = await import(
  '../src/viewer/InteractiveViewerServer.js'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function getJSON(pathname) {
  const port = process.env.PORT || 3007;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Load a manifest
const manifest = 'output/Alte_Donau.json';
await getJSON('/loadImage?jsonPath=' + encodeURIComponent(manifest));

// Choose two URIs that exist in the manifest; fall back to a pair that likely exists
const regionsResp = await getJSON(
  '/relationships?uri=' + encodeURIComponent('uri://Alte_Donau/tiledImage/0'),
);
const baseUri = 'uri://Alte_Donau/tiledImage/0';
const other =
  Array.isArray(regionsResp) && regionsResp[0]
    ? regionsResp[0].other
    : 'uri://Alte_Donau/tiledImage/1';

// Connect socket
const port = process.env.PORT || 3007;
const client = new Client(`http://127.0.0.1:${port}`);
await new Promise((res) => client.on('connect', res));

// Update metadata (works regardless of active/deleted predicate as server normalizes)
client.emit('updateRelationshipMeta', {
  subject: baseUri,
  predicate: 'http://example.org/metadata#near',
  object: other,
  name: 'test-name',
  description: 'test-desc',
});
await sleep(200);

const after = await getJSON(
  '/relationships?uri=' + encodeURIComponent(baseUri),
);
const found = (after || []).find(
  (r) => r.other === other && /metadata#near$/.test(r.predicate),
);
if (found) {
  assert.strictEqual(found.name, 'test-name');
  assert.strictEqual(found.description, 'test-desc');
}

console.log('Relationships e2e meta socket test passed');
process.exit(0);
