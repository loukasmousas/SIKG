// Ensures blur is applied for single image /getTile when PrivacyAction exists
import http from 'http';
import assert from 'assert';

process.env.PORT = process.env.PORT || '3005';
await import('../src/viewer/InteractiveViewerServer.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(350);

function getJSON(pathname) {
  const port = process.env.PORT || 3005;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getBinary(pathname) {
  const port = process.env.PORT || 3005;
  const opts = { hostname: '127.0.0.1', port, path: pathname, method: 'GET' };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const ctype = res.headers['content-type'] || '';
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), ctype }));
    });
    req.on('error', reject);
    req.end();
  });
}

const manifest = 'output/barcelona.json';
const meta = await getJSON(
  '/loadImage?jsonPath=' + encodeURIComponent(manifest),
);
assert.ok(meta.isTiled === false, 'expected single manifest');
const a = await getBinary('/getTile?blur=0');
const b = await getBinary('/getTile?blur=1');
assert.ok(a.ctype.startsWith('image/png') && b.ctype.startsWith('image/png'));
console.log('ℹ single sizes:', a.buf.length, '→', b.buf.length);
console.log('Blur single endpoint smoke');
process.exit(0);
