// tests/get-tile-endpoint.test.mjs
// Smoke test for GET /getTile to ensure PNG is served for single and tiled images
import http from 'http';
import assert from 'assert';

// Use an alternate port
process.env.PORT = process.env.PORT || '3003';

// Boot the server module (it listens immediately)
await import('../src/viewer/InteractiveViewerServer.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(350);

function getJSON(pathname) {
  const port = process.env.PORT || 3003;
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

function getBinary(pathname) {
  const port = process.env.PORT || 3003;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const ctype =
        res.headers['content-type'] || res.headers['Content-Type'] || '';
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ buf, ctype: String(ctype) });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Load a known manifest
const manifest = 'output/Alte_Donau.json';
const imgResp = await getJSON(
  '/loadImage?jsonPath=' + encodeURIComponent(manifest),
);
assert.ok(
  imgResp && typeof imgResp.isTiled === 'boolean',
  'invalid loadImage payload',
);

// Fetch a tile or the single image via /getTile
const pathTile =
  imgResp.isTiled && imgResp.tileManifest?.length > 0
    ? '/getTile?index=0'
    : '/getTile';

const { buf, ctype } = await getBinary(pathTile);
assert.ok(ctype.startsWith('image/png'), 'expected image/png, got ' + ctype);
assert.ok(buf.length > 1000, 'PNG too small or empty: ' + buf.length);

console.log('/getTile smoke test passed:', pathTile, buf.length + ' bytes');
process.exit(0);
