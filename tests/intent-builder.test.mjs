import assert from 'assert';
import path from 'path';
import url from 'url';

// Import the builder and validator via dynamic import from VoiceService.js
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const vsPath = path.join(__dirname, '..', 'src', 'voice', 'VoiceService.js');
const mod = await import(url.pathToFileURL(vsPath).href);

// Access non-exported functions via eval-free approach is not possible; instead,
// re-construct a tiny intent that VoiceService can process through the builder it exposes.
// To enable this test, export buildSparqlFromIntent and validateIntent from VoiceService.
const {
  default: _unused,
  buildSparqlFromIntent: build,
  validateIntent: validate,
} = mod;

assert.ok(typeof build === 'function', 'buildSparqlFromIntent is exported');
assert.ok(typeof validate === 'function', 'validateIntent is exported');

// Happy path: pairs named owner (near)
const intent1 = {
  target: 'pairs',
  relationships: { predicates: ['near'] },
  metaFilters: { name: { equals: 'owner' } },
  projection: { vars: ['s', 'o'], limit: 50 },
};
const v1 = validate(intent1);
assert.ok(v1.ok, 'intent1 validation ok');
const q1 = build(v1.value);
assert.ok(/SELECT \?s \?o/i.test(q1), 'q1 selects s o');
assert.ok(/rdf:predicate \?pred/.test(q1), 'q1 binds predicate to ?pred');
assert.ok(
  /VALUES \?pred \{ md:near \}/.test(q1),
  'q1 restricts predicate via VALUES',
);
assert.ok(
  /OPTIONAL \{ \?stmt \(md:relationshipName\|rdfs:label\) \?_nm \. \}/.test(q1),
  'q1 has OPTIONAL name binding',
);
assert.ok(
  /FILTER\(BOUND\(\?_nm\) && LCASE\(STR\(\?_nm\)\) = "owner"\)/.test(q1),
  'q1 equals name filter present',
);

// Regions with type and tags
const intent2 = {
  target: 'regions',
  image: 'urn:image:test',
  types: ['ex:person'],
  metaFilters: { tags: ['captain'] },
  projection: { vars: ['r'], limit: 10 },
};
const v2 = validate(intent2);
assert.ok(v2.ok, 'intent2 validation ok');
const q2 = build(v2.value);
assert.ok(/SELECT \?r/.test(q2), 'q2 selects r');
assert.ok(/\?r ex:within <urn:image:test>/.test(q2), 'q2 filters image');
assert.ok(/\?r a ex:person/.test(q2), 'q2 filters type');
assert.ok(
  /md:tags \?tag/.test(q2) && /CONTAINS\(LCASE\(STR\(\?tag\)\),/.test(q2),
  'q2 filters tags',
);

console.log('intent-builder.test.mjs PASS');
