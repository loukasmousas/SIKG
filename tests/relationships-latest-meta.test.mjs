// tests/relationships-latest-meta.test.mjs
// Verify that the latest name/description are returned by /relationships after multiple updates
import assert from 'assert';
import { io as Client } from 'socket.io-client';
import http from 'http';

process.env.PORT = process.env.PORT || '3011';
const { default: _serverMod } = await import(
  '../src/viewer/InteractiveViewerServer.js'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(300);

function getJSON(pathname) {
  const port = process.env.PORT || 3011;
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

async function postSPARQL(query) {
  const port = process.env.PORT || 3011;
  const opts = {
    hostname: '127.0.0.1',
    port,
    path: '/sparql',
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
  };
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
    req.write(query);
    req.end();
  });
}

// Load a manifest
const manifest = 'output/Alte_Donau.json';
await getJSON('/loadImage?jsonPath=' + encodeURIComponent(manifest));

const baseUri = 'uri://Alte_Donau/tiledImage/0';
const rels = await getJSON('/relationships?uri=' + encodeURIComponent(baseUri));
const other =
  Array.isArray(rels) && rels[0]
    ? rels[0].other
    : 'uri://Alte_Donau/tiledImage/1';

const port = process.env.PORT || 3011;
const client = new Client(`http://127.0.0.1:${port}`);
await new Promise((res) => client.on('connect', res));

// Ensure a NEAR relationship exists for (baseUri, other)
client.emit('updateRegion', {
  regionId: 'region-test',
  ontologyAction: { relation: 'near', uriA: baseUri, uriB: other },
});
await sleep(250);

// First set
client.emit('updateRelationshipMeta', {
  subject: baseUri,
  predicate: 'http://example.org/metadata#near',
  object: other,
  name: 'first-name',
  description: 'first-desc',
});
await sleep(150);

// Second set (should be returned)
client.emit('updateRelationshipMeta', {
  subject: baseUri,
  predicate: 'http://example.org/metadata#near',
  object: other,
  name: 'second-name',
  description: 'second-desc',
});
await sleep(400);

const after = await getJSON(
  '/relationships?uri=' + encodeURIComponent(baseUri),
);
console.log(
  'DEBUG relationships count=',
  Array.isArray(after) ? after.length : 'n/a',
);
console.log(
  'DEBUG relationships sample=',
  Array.isArray(after) ? after.slice(0, 3) : after,
);
const found = (after || []).find(
  (r) => r.other === other && /metadata#near$/.test(r.predicate),
);
console.log('DEBUG found entry=', found);

// Query reified triples directly
const sparql = `
PREFIX rdf:<http://www.w3.org/1999/02/22-rdf-syntax-ns#>
PREFIX rdfs:<http://www.w3.org/2000/01/rdf-schema#>
PREFIX md:<http://example.org/metadata#>
SELECT ?stmt ?nm ?lbl ?desc WHERE {
  ?stmt rdf:subject <${baseUri}> ; rdf:predicate md:near ; rdf:object <${other}> .
  OPTIONAL { ?stmt md:relationshipName ?nm }
  OPTIONAL { ?stmt rdfs:label ?lbl }
  OPTIONAL { ?stmt md:relationshipDescription ?desc }
}`;
const rows = await postSPARQL(sparql);
console.log('DEBUG SPARQL rows=', rows);
assert(found, 'relationship not found');
assert.strictEqual(found.name, 'second-name');
assert.strictEqual(found.description, 'second-desc');
console.log('Relationships latest meta test passed');
process.exit(0);
