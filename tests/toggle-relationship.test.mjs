// tests/toggle-relationship.test.mjs
// Covers soft-delete/restore via the server's toggleRelationship socket event.
import http from 'http';
import assert from 'assert';
import { io as ioc } from 'socket.io-client';

// Use an alternate port
process.env.PORT = process.env.PORT || '3005';
process.env.DEBUG = process.env.DEBUG || '1';

// Boot the server module (it listens immediately)
await import('../src/viewer/InteractiveViewerServer.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(400);

function getJSON(pathname) {
  const port = process.env.PORT || 3005;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (_e) {
          reject(new Error('Non-JSON response: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Load a manifest and pick two region URIs
const manifest = 'output/Alte_Donau.json';
const imgResp = await getJSON(
  '/loadImage?jsonPath=' + encodeURIComponent(manifest),
);
assert.ok(
  imgResp && Array.isArray(imgResp.regions),
  'invalid loadImage payload',
);
const uris = imgResp.regions.map((r) => r?.metadata?.uri).filter(Boolean);
if (uris.length < 2) {
  console.log('⚠️  Not enough regions to test toggling; skipping');
  process.exit(0);
}
const [A, B] = uris;
const regA = imgResp.regions.find((r) => r?.metadata?.uri === A);
assert.ok(regA?.id && regA.boundary, 'region A missing fields');

// Connect socket and ensure an active "near" relationship exists (via updateRegion)
const port = process.env.PORT || 3005;
const sock = ioc(`http://127.0.0.1:${port}`);
await new Promise((resolve) => sock.on('connect', resolve));

sock.emit('updateRegion', {
  regionId: regA.id,
  newTags: regA.tags || [],
  newMeta: {},
  boundary: regA.boundary,
  ontologyAction: { relation: 'near', uriA: A, uriB: B },
});
await sleep(150);

const list = async () =>
  await getJSON('/relationships?uri=' + encodeURIComponent(A));

const hasRow = (rows, deleted) =>
  rows.some((r) => {
    const isNear = deleted
      ? /metadata#deletedNear$/.test(r.predicate)
      : /metadata#near$/.test(r.predicate);
    return isNear && r.other === B && !!r.deleted === !!deleted;
  });

let rows = await list();
assert.ok(Array.isArray(rows), 'relationships should be array');
assert.ok(
  rows.some(
    (r) => /metadata#(?:deleted)?near$/.test(r.predicate) && r.other === B,
  ),
  'near relationship A->B should exist after insert',
);

// Toggle to deleted
sock.emit('toggleRelationship', {
  subject: A,
  predicate: 'http://example.org/metadata#near',
  object: B,
  enabled: false,
});
await sleep(120);
rows = await list();
assert.ok(hasRow(rows, true), 'relationship should be soft-deleted');

// Toggle back to active
sock.emit('toggleRelationship', {
  subject: A,
  predicate: 'http://example.org/metadata#near',
  object: B,
  enabled: true,
});
await sleep(120);
rows = await list();
assert.ok(hasRow(rows, false), 'relationship should be restored active');

console.log('ToggleRelationship soft-delete/restore test passed');
process.exit(0);
