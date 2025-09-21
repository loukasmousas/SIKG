// tests/relationships-endpoint.test.mjs
// Minimal smoke test for GET /relationships endpoint
import http from 'http';
import assert from 'assert';
import { once as _once } from 'events';

// Start the interactive viewer server on an alternate port to avoid conflicts
process.env.PORT = process.env.PORT || '3001';

const { default: _serverMod } = await import(
  '../src/viewer/InteractiveViewerServer.js'
);
// The server module starts listening immediately. No direct handle exported.
// Wait a moment for it to bind.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

// Helper to GET JSON
function getJSON(pathname) {
  const port = process.env.PORT || 3001;
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

// Load a known manifest to prime state
const manifest = 'output/Alte_Donau.json';
const imgResp = await getJSON(
  '/loadImage?jsonPath=' + encodeURIComponent(manifest),
);
assert.ok(
  imgResp && imgResp.regions?.length >= 0,
  'loadImage returned invalid payload',
);

// Pick a URI from active regions if available, else fallback to a fabricated one
let testUri =
  imgResp.regions.find((r) => r?.metadata?.uri)?.metadata?.uri || null;
if (!testUri && imgResp.allRegions?.length)
  testUri = imgResp.allRegions.find((r) => r?.metadata?.uri)?.metadata?.uri;
assert.ok(testUri, 'Could not find any region URI in manifest to test');

// Hit /relationships
const rows = await getJSON('/relationships?uri=' + encodeURIComponent(testUri));
assert.ok(Array.isArray(rows), 'relationships should return a JSON array');
// shape: { predicate, other, incoming, deleted } at minimum
if (rows[0]) {
  assert.strictEqual(typeof rows[0].predicate, 'string');
  assert.strictEqual(typeof rows[0].other, 'string');
  assert.strictEqual(typeof rows[0].incoming, 'boolean');
  assert.strictEqual(typeof rows[0].deleted, 'boolean');
}

console.log(
  '/relationships smoke test passed with',
  rows.length,
  'rows for',
  testUri,
);

// No explicit shutdown as server process is the test runner. Exit explicitly.
process.exit(0);
