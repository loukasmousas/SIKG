// ontology-idempotence.test.mjs
import OntExt from '../src/common/OntologyExtensions.js';
import MetadataIndex from '../src/common/MetadataIndex.js';

const mi = new MetadataIndex();
const A = 'urn:ra',
  B = 'urn:rb';
OntExt.insertNearRelationship(mi, A, B);
OntExt.insertNearRelationship(mi, A, B);
OntExt.insertContainsRelationship(mi, A, B);
OntExt.insertContainsRelationship(mi, A, B);
const nearQuads = mi.store
  .getQuads(null, null, null, null)
  .filter((q) => q.predicate.value.endsWith('#near'));
const containsQuads = mi.store
  .getQuads(null, null, null, null)
  .filter((q) => q.predicate.value.endsWith('#contains'));
if (nearQuads.length !== 1 || containsQuads.length !== 1) {
  console.error('Expected single quad after duplicate inserts');
  process.exitCode = 1;
} else
  console.log(
    'Ontology deduplication test passed (store collapses duplicates).',
  );
