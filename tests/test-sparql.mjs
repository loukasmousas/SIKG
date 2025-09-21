// test-sparql.mjs
// ------------------------------------------------------------------
//  Rebuilds a MetadataIndex from any *.json manifest (single- or
//  multi-tile) and executes an arbitrary SPARQL query.
//
//     node test-sparql.mjs <manifest.json> [query.sparql]
//
//  If you omit the query file, a small “show me every person in this
//  image” demo query is executed.

import fs from 'fs/promises';
import path from 'path';
import MetadataIndex from '../src/common/MetadataIndex.js';

async function main() {
  const [, , jsonPath, queryPath] = process.argv;
  if (!jsonPath) {
    console.error('Usage: node test-sparql.mjs <manifest.json> [query.sparql]');
    process.exit(1);
  }
  const raw = await fs.readFile(path.resolve(jsonPath), 'utf8');
  const manifest = JSON.parse(raw);
  if (!manifest.metadataIndex) {
    throw new Error(
      'manifest has no "metadataIndex" field -- is the file valid?',
    );
  }
  const mi = await MetadataIndex.fromJSON(manifest.metadataIndex);
  console.log(`Loaded ${mi.store.size} RDF triples from ${jsonPath}`);
  let sparql;
  if (queryPath) {
    sparql = await fs.readFile(path.resolve(queryPath), 'utf8');
  } else {
    const imgUrn = 'urn:image:' + path.basename(jsonPath, '.json');
    sparql = `\n      PREFIX ex: <http://example.org/>\n      SELECT ?r ?conf ?x ?y ?w ?h\n      WHERE {\n        ?r a ex:person ;\n           ex:within <${imgUrn}> ;\n           ex:confidence ?conf ;\n           ex:x ?x ; ex:y ?y ; ex:w ?w ; ex:h ?h .\n      } ORDER BY DESC(?conf)`;
  }
  const bindings = await mi.executeSPARQL(sparql);
  console.log(`Query produced ${bindings.length} row(s)\n`);
  // Each binding is a Map from variable name (without '?') to RDFJS term.
  // Ensure we output a stable ordering matching SELECT clause if possible.
  const selectVars = Array.from(
    new Set(
      (sparql.match(/SELECT[\s\S]*?WHERE/i) || [''])[0]
        .replace(/SELECT/i, '')
        .replace(/WHERE/i, '')
        .split(/\s+/)
        .filter((v) => v.startsWith('?'))
        .map((v) => v.replace(/^\?/, '')),
    ),
  );
  bindings.forEach((b, i) => {
    const obj = {};
    selectVars.forEach((v) => {
      if (b.has(v)) obj[v] = b.get(v).value;
    });
    for (const [k, v] of b) {
      if (
        !selectVars.includes(k) &&
        typeof k === 'string' &&
        k &&
        k !== '[object Object]'
      ) {
        obj[k] = v.value;
      }
    }
    console.log(String(i + 1).padStart(3, ' '), obj);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
