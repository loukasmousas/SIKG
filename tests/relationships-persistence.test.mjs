// tests/relationships-persistence.test.mjs
// Ensure relationship name/description persist across save + reload
import assert from 'assert';
import { io as Client } from 'socket.io-client';
import http from 'http';

process.env.PORT = process.env.PORT || '3012';
const { default: _serverMod } = await import(
  '../src/viewer/InteractiveViewerServer.js'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function getJSON(pathname) {
  const port = process.env.PORT || 3012;
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

async function post(pathname) {
  const port = process.env.PORT || 3012;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

// Load manifest
const manifest = 'output/Alte_Donau.json';
await getJSON('/loadImage?jsonPath=' + encodeURIComponent(manifest));

const baseUri = 'uri://Alte_Donau/tiledImage/0';
const other = 'uri://Alte_Donau/tiledImage/1';

// Socket connect and set relationship metadata
const port = process.env.PORT || 3012;
const client = new Client(`http://127.0.0.1:${port}`);
await new Promise((res) => client.on('connect', res));
// Ensure the NEAR relationship exists
client.emit('updateRegion', {
  regionId: 'region-persist-test',
  ontologyAction: { relation: 'near', uriA: baseUri, uriB: other },
});
await sleep(200);
client.emit('updateRelationshipMeta', {
  subject: baseUri,
  predicate: 'http://example.org/metadata#near',
  object: other,
  name: 'persist-name',
  description: 'persist-desc',
});
await sleep(200);

// Save changes
await post('/saveChanges');
await sleep(200);

// Reload manifest
await getJSON('/loadImage?jsonPath=' + encodeURIComponent(manifest));
await sleep(200);

// Verify relationship meta still present
const rows = await getJSON('/relationships?uri=' + encodeURIComponent(baseUri));
const found = (rows || []).find(
  (r) => r.other === other && /metadata#near$/.test(r.predicate),
);
assert(found, 'relationship not found after reload');
assert.strictEqual(found.name, 'persist-name');
assert.strictEqual(found.description, 'persist-desc');

console.log('Relationships persistence test passed');
process.exit(0);
