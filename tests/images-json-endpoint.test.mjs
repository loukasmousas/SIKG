// tests/images-json-endpoint.test.mjs
// Smoke test for GET /images.json payload shape
import http from 'http';
import assert from 'assert';

process.env.PORT = process.env.PORT || '3007';
await import('../src/viewer/InteractiveViewerServer.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function get(pathname) {
  const port = process.env.PORT || 3007;
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

const { status, body } = await get('/images.json');
assert.strictEqual(status, 200, 'images.json should be 200');
let arr;
try {
  arr = JSON.parse(body);
} catch {
  throw new Error('images.json did not return JSON');
}
assert.ok(Array.isArray(arr), 'images.json should return an array');
if (arr[0]) {
  const v = arr[0];
  assert.ok(typeof v.id === 'string', 'id missing');
  assert.ok(typeof v.thumb === 'string', 'thumb missing');
  assert.ok(typeof v.full === 'string', 'full missing');
  // base and hasManifest are optional but helpful
  if ('hasManifest' in v) assert.ok(typeof v.hasManifest === 'boolean');
  if (v.hasManifest)
    assert.ok(
      typeof v.jsonPath === 'string',
      'jsonPath should be provided when hasManifest=true',
    );
}
console.log('/images.json smoke test passed with', arr.length, 'items');
process.exit(0);
