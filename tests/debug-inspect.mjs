import fs from 'fs/promises';
import path from 'path';
import MetadataIndex from '../src/common/MetadataIndex.js';

const jsonPath = path.resolve('output/barcelona.json');
const raw = await fs.readFile(jsonPath, 'utf8');
const manifest = JSON.parse(raw);
const mi = await MetadataIndex.fromJSON(manifest.metadataIndex);
if (typeof mi.ensureImageScoping === 'function') mi.ensureImageScoping();

async function runQuery(sparql) {
  const rows = await mi.executeSPARQL(sparql);
  return rows.map((b) => {
    const obj = {};
    for (const [k, v] of b) obj[k.value] = v.value;
    return obj;
  });
}

const img = 'urn:image:barcelona';

const q1 = `PREFIX ex:<http://example.org/>
PREFIX md:<http://example.org/metadata#>
SELECT ?r ?t WHERE { ?r md:tags ?t . FILTER(CONTAINS(LCASE(STR(?t)), "person")) . ?r ex:within <${img}> }`;
const r1 = await runQuery(q1);
console.log('tags=person rows:', r1);

const q2 = `PREFIX ex:<http://example.org/>
PREFIX md:<http://example.org/metadata#>
SELECT ?r WHERE { ?r md:classLabel ?cl . FILTER(LCASE(STR(?cl))="person") . ?r ex:within <${img}> }`;
const r2 = await runQuery(q2);
console.log('classLabel=person rows:', r2);

const q3 = `PREFIX ex:<http://example.org/>
SELECT ?r WHERE { ?r a ex:person . ?r ex:within <${img}> }`;
const r3 = await runQuery(q3);
console.log('rdf:type ex:person rows:', r3);

const q4 = `PREFIX ex:<http://example.org/>
PREFIX md:<http://example.org/metadata#>
SELECT ?r WHERE { { { ?r a ex:person } UNION { ?r md:classLabel ?cl . FILTER(LCASE(STR(?cl))="person") } UNION { ?r md:tags ?t . FILTER(CONTAINS(LCASE(STR(?t)),"person")) } } ?r ex:within <${img}> }`;
const r4 = await runQuery(q4);
console.log('UNION combined rows:', r4);
