// tests/relationships-history-arrays.test.mjs
// Assert that name/description history arrays are populated after multiple updates
import assert from 'assert';
import { io as Client } from 'socket.io-client';
import http from 'http';

process.env.PORT = process.env.PORT || '3015';
const { default: _serverMod } = await import(
  '../src/viewer/InteractiveViewerServer.js'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function getJSON(pathname) {
  const port = process.env.PORT || 3015;
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

const baseUri = 'uri://Alte_Donau/tiledImage/0';
const other = 'uri://Alte_Donau/tiledImage/1';

const port = process.env.PORT || 3015;
const client = new Client(`http://127.0.0.1:${port}`);
await new Promise((res) => client.on('connect', res));

// Ensure a NEAR relationship exists
client.emit('updateRegion', {
  regionId: 'region-hist-test',
  ontologyAction: { relation: 'near', uriA: baseUri, uriB: other },
});
await sleep(200);

// First set
client.emit('updateRelationshipMeta', {
  subject: baseUri,
  predicate: 'http://example.org/metadata#near',
  object: other,
  name: 'first-name',
  description: 'first-desc',
});
await sleep(150);

// Second set
client.emit('updateRelationshipMeta', {
  subject: baseUri,
  predicate: 'http://example.org/metadata#near',
  object: other,
  name: 'second-name',
  description: 'second-desc',
});
await sleep(300);

const rows = await getJSON('/relationships?uri=' + encodeURIComponent(baseUri));
const found = (rows || []).find(
  (r) => r.other === other && /metadata#near$/.test(r.predicate),
);
assert(found, 'relationship not found');
assert.strictEqual(found.name, 'second-name');
assert.strictEqual(found.description, 'second-desc');
assert(Array.isArray(found.nameHistory), 'nameHistory missing');
assert(Array.isArray(found.descriptionHistory), 'descriptionHistory missing');
assert(
  found.nameHistory.length >= 1,
  'nameHistory should contain at least one entry',
);
assert(
  found.descriptionHistory.length >= 1,
  'descriptionHistory should contain at least one entry',
);

console.log('Relationships history arrays test passed');
process.exit(0);
