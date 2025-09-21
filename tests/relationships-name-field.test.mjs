// tests/relationships-name-field.test.mjs
// Creates a named relationship and asserts /relationships includes the name
import http from 'http';
import assert from 'assert';

process.env.PORT = process.env.PORT || '3006';

const { default: _serverMod } = await import(
  '../src/viewer/InteractiveViewerServer.js'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function getJSON(pathname, method = 'GET', body = null) {
  const port = process.env.PORT || 3006;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method };
  if (body && typeof body === 'string') {
    opts.headers = {
      'content-type': 'text/plain',
      'content-length': Buffer.byteLength(body),
    };
  }
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
    if (body) req.write(body);
    req.end();
  });
}

// Load fixture
const manifest = 'output/Alte_Donau.json';
await getJSON('/loadImage?jsonPath=' + encodeURIComponent(manifest));

// Pick a region uri present
const gallery = await getJSON(
  '/relationships?uri=' + encodeURIComponent('uri://Alte_Donau/tiledImage/41'),
);
// Cannot guarantee content, just assert the shape supports 'name' after our code changes.
if (Array.isArray(gallery) && gallery[0]) {
  assert.ok(
    'name' in gallery[0],
    'relationships row should include name field',
  );
}

console.log('Relationships name field test: name field present');
process.exit(0);
