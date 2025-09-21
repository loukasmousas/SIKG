// manual-exwithin-and-type-matching.test.mjs
// Verifies that manual regions get image scoping via ex:within and that
// generalized type matching finds manual-tagged/class-labeled regions.

import fs from 'fs/promises';
import path from 'path';
import MetadataIndex from '../src/common/MetadataIndex.js';

async function runQuery(mi, sparql) {
  const rows = await mi.executeSPARQL(sparql);
  return rows.map((b) => {
    const obj = {};
    for (const [k, v] of b) obj[k.value] = v.value;
    return obj;
  });
}

async function main() {
  const jsonPath = path.resolve('output/barcelona.json');
  const raw = await fs.readFile(jsonPath, 'utf8');
  const manifest = JSON.parse(raw);
  const mi = await MetadataIndex.fromJSON(manifest.metadataIndex);
  // Make sure the index has image scoping for manual regions even outside the live server
  if (typeof mi.ensureImageScoping === 'function') mi.ensureImageScoping();
  const img = 'urn:image:barcelona';

  // Manual sunglasses regions should be scoped to image via ex:within
  const qWithin = `PREFIX ex:<http://example.org/>
PREFIX md:<http://example.org/metadata#>
SELECT ?r WHERE { ?r ex:within <${img}> . ?r md:tags ?t . FILTER(CONTAINS(LCASE(STR(?t)), "sunglasses")) }`;
  const withinRows = await runQuery(mi, qWithin);
  if (withinRows.length < 1) {
    throw new Error(
      'Expected at least one manual sunglasses region with ex:within image scoping',
    );
  }

  // Generalized type matching: simulate VoiceService builder behavior
  // Mimic searching for ex:person but allow classLabel/tags fallbacks
  const qGenericType = `PREFIX ex:<http://example.org/>
PREFIX md:<http://example.org/metadata#>
SELECT ?r WHERE {
  { { ?r a ex:person } UNION { ?r md:classLabel ?cl . FILTER(LCASE(STR(?cl))="person") } UNION { ?r md:tags ?t . FILTER(CONTAINS(LCASE(STR(?t)),"person")) } }
  ?r ex:within <${img}>
}`;
  const genericRows = await runQuery(mi, qGenericType);
  const hasManualPerson = genericRows.some(
    (r) => r.r && r.r.includes('manual-region'),
  );
  if (!hasManualPerson) {
    throw new Error(
      'Expected manual person to be discovered via generalized matching',
    );
  }

  console.log('OK manual-exwithin-and-type-matching');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
