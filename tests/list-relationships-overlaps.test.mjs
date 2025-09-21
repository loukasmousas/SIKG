import assert from 'assert';
import { Store, DataFactory } from 'n3';
import { listRelationships } from '../src/common/Relationships.js';
import { REL, DELREL } from '../src/common/rel-const.js';

const store = new Store();
store.relMeta = new Map();

const { namedNode } = DataFactory;
const subj = 'uri://example/image/region-1';
const other = 'uri://example/image/region-2';

store.addQuad(namedNode(subj), namedNode(REL.overlaps), namedNode(other));
store.addQuad(namedNode(other), namedNode(DELREL.overlaps), namedNode(subj));

const rows = listRelationships(store, subj, REL, DELREL);

const hasActiveOverlap = rows.find(
  (row) =>
    row.predicate === REL.overlaps &&
    row.other === other &&
    row.deleted === false &&
    row.incoming === false,
);
assert.ok(hasActiveOverlap, 'active overlaps relationship should be returned');

const hasDeletedIncoming = rows.find(
  (row) =>
    row.predicate === DELREL.overlaps &&
    row.other === other &&
    row.deleted === true &&
    row.incoming === true,
);
assert.ok(
  hasDeletedIncoming,
  'deleted overlaps relationship should be returned as incoming',
);

console.log('Overlaps relationships listed correctly');
