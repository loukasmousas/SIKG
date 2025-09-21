import fs from 'fs/promises';
import path from 'path';
import MetadataIndex from '../src/common/MetadataIndex.js';

const raw = await fs.readFile(path.resolve('output/barcelona.json'), 'utf8');
const manifest = JSON.parse(raw);
const mi = await MetadataIndex.fromJSON(manifest.metadataIndex);

function show(q) {
  return mi.executeSPARQL(q).then((rows) => {
    console.log('rows:', rows.length);
    rows.forEach((b, i) => {
      const o = Object.fromEntries([...b].map(([k, v]) => [k, v.value]));
      console.log(i + 1, o);
    });
  });
}

const img = 'urn:image:barcelona';
const Q1 = `PREFIX ex:<http://example.org/>
PREFIX md:<http://example.org/metadata#>
SELECT ?r WHERE { ?r ex:within <${img}> . ?r md:tags ?t . FILTER(CONTAINS(LCASE(STR(?t)), "sunglasses")) }`;

await show(Q1);

const Q2 = `SELECT ?p ?o WHERE { <uri://barcelona/manual-region/manual-102> ?p ?o }`;
await show(Q2);
