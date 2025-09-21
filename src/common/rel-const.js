// rel-const.js
// Canonical relationship IRIs used across the project.

export const REL = {
  near: 'http://example.org/metadata#near',
  contains: 'http://example.org/metadata#contains',
  sameObjectAs: 'http://example.org/metadata#sameObjectAs',
  overlaps: 'http://example.org/metadata#overlaps',
  clusterLinkedTo: 'http://example.org/metadata#clusterLinkedTo',
};

export const DELREL = {
  near: 'http://example.org/metadata#deletedNear',
  contains: 'http://example.org/metadata#deletedContains',
  sameObjectAs: 'http://example.org/metadata#deletedSameObjectAs',
  overlaps: 'http://example.org/metadata#deletedOverlaps',
  clusterLinkedTo: 'http://example.org/metadata#deletedClusterLinkedTo',
};

export const ALL_REL_P = new Set([
  REL.near,
  REL.contains,
  REL.sameObjectAs,
  REL.overlaps,
  REL.clusterLinkedTo,
  DELREL.near,
  DELREL.contains,
  DELREL.sameObjectAs,
  DELREL.overlaps,
  DELREL.clusterLinkedTo,
]);

export const toKey = (p) =>
  p === REL.near || p === DELREL.near
    ? 'near'
    : p === REL.contains || p === DELREL.contains
      ? 'contains'
      : p === REL.sameObjectAs || p === DELREL.sameObjectAs
        ? 'sameObjectAs'
        : p === REL.overlaps || p === DELREL.overlaps
          ? 'overlaps'
          : p === REL.clusterLinkedTo || p === DELREL.clusterLinkedTo
            ? 'clusterLinkedTo'
            : null;

export default { REL, DELREL, ALL_REL_P, toKey };
