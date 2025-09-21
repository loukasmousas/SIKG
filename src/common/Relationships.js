// Relationships.js
//
// Purpose: List relationships for a given URI from an RDF (N3) store, including
// outgoing/incoming and active/deleted variants. Pulls reified metadata (name/description
// + histories) where available via deterministic statement IRIs (see OntologyExtensions).

import crypto from 'crypto';
import { DataFactory } from 'n3';
const { namedNode } = DataFactory;

export function listRelationships(store, uri, REL, DELREL) {
  const S = namedNode(uri);
  const out = [];
  const keys = [
    'near',
    'contains',
    'sameObjectAs',
    'overlaps',
    'clusterLinkedTo',
  ];
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const MD = 'http://example.org/metadata#';

  function baseP(pred) {
    // Map deleted variants back to base predicate for naming lookups
    if (pred === DELREL.near) return REL.near;
    if (pred === DELREL.contains) return REL.contains;
    if (pred === DELREL.sameObjectAs) return REL.sameObjectAs;
    if (pred === DELREL.overlaps) return REL.overlaps;
    if (pred === DELREL.clusterLinkedTo) return REL.clusterLinkedTo;
    return pred;
  }

  function stmtIRI(subjectURI, basePredicateURI, objectURI) {
    const key = `${subjectURI}|${basePredicateURI}|${objectURI}`;
    const h = crypto.createHash('sha1').update(key).digest('hex');
    // Related background: RDF reification (naming a statement for metadata)
    // https://www.w3.org/TR/rdf-schema/#ch_reificationvocab
    return `${MD}stmt/${h}`;
  }

  function lookupMeta(subjectURI, predicateURI, objectURI) {
    // Prefer the canonical stmt IRI and read metadata directly; fallback to scan
    const s = namedNode(subjectURI);
    const p = namedNode(predicateURI);
    const o = namedNode(objectURI);
    const canonical = namedNode(stmtIRI(subjectURI, predicateURI, objectURI));
    const tryRead = (stmt) => {
      // Always compute histories from RDF store (cache may not hold them)
      const nHistRdf = store
        .getQuads(stmt, namedNode(`${MD}relationshipNameHistory`), null, null)
        .map((q) => q.object?.value)
        .filter(Boolean);
      const dHistRdf = store
        .getQuads(
          stmt,
          namedNode(`${MD}relationshipDescriptionHistory`),
          null,
          null,
        )
        .map((q) => q.object?.value)
        .filter(Boolean);
      // For current values, prefer cache when present; otherwise read last RDF value
      const pickLatest = (quads) =>
        quads && quads.length
          ? quads[quads.length - 1]?.object?.value
          : undefined;
      const nmRdf =
        pickLatest(
          store.getQuads(stmt, namedNode(`${MD}relationshipName`), null, null),
        ) ||
        pickLatest(store.getQuads(stmt, namedNode(`${RDFS}label`), null, null));
      const descRdf = pickLatest(
        store.getQuads(
          stmt,
          namedNode(`${MD}relationshipDescription`),
          null,
          null,
        ),
      );
      const relMetaMap = store?.relMeta || store?._relMeta;
      const cached =
        relMetaMap && relMetaMap.get ? relMetaMap.get(stmt.value) : null;
      const nm = (cached && cached.name != null ? cached.name : nmRdf) || null;
      const desc =
        (cached && cached.description != null ? cached.description : descRdf) ||
        null;
      // Merge cache history with RDF history to be robust against pruning
      const nHistCache = Array.isArray(cached?.nameHistory)
        ? cached.nameHistory
        : [];
      const dHistCache = Array.isArray(cached?.descriptionHistory)
        ? cached.descriptionHistory
        : [];
      const nHist = [...new Set([...(nHistRdf || []), ...nHistCache])];
      const dHist = [...new Set([...(dHistRdf || []), ...dHistCache])];
      if (nm || desc || nHist.length || dHist.length) {
        return {
          name: nm,
          description: desc,
          nameHistory: nHist,
          descriptionHistory: dHist,
        };
      }
      return null;
    };
    // debug logging removed for cleanliness; enable if needed
    // Try reading canonical (will merge cache for current values and RDF for history)
    const canonicalMeta = tryRead(canonical);
    const candidates = canonicalMeta
      ? [{ subject: canonical }]
      : store.getQuads(null, namedNode(`${RDF}predicate`), p, null);
    for (const cand of candidates) {
      const stmt = cand.subject;
      const subjOk =
        store.getQuads(stmt, namedNode(`${RDF}subject`), s, null).length > 0;
      if (!subjOk) continue;
      const objOk =
        store.getQuads(stmt, namedNode(`${RDF}object`), o, null).length > 0;
      if (!objOk) continue;
      const got = tryRead(stmt);
      if (got) return got;
    }
    return {
      name: null,
      description: null,
      nameHistory: [],
      descriptionHistory: [],
    };
  }
  for (const k of keys) {
    const pA = namedNode(REL[k]);
    const pD = namedNode(DELREL[k]);
    // outgoing active/deleted
    store.getQuads(S, pA, null, null).forEach((q) => {
      const other = q.object.value;
      const meta = lookupMeta(uri, baseP(REL[k]), other);
      out.push({
        predicate: REL[k],
        other,
        incoming: false,
        deleted: false,
        name: meta.name,
        description: meta.description,
        nameHistory: meta.nameHistory,
        descriptionHistory: meta.descriptionHistory,
      });
    });
    store.getQuads(S, pD, null, null).forEach((q) => {
      const other = q.object.value;
      const meta = lookupMeta(uri, baseP(DELREL[k]), other);
      out.push({
        predicate: DELREL[k],
        other,
        incoming: false,
        deleted: true,
        name: meta.name,
        description: meta.description,
        nameHistory: meta.nameHistory,
        descriptionHistory: meta.descriptionHistory,
      });
    });
    // incoming active/deleted
    store.getQuads(null, pA, S, null).forEach((q) => {
      const other = q.subject.value;
      const meta = lookupMeta(other, baseP(REL[k]), uri);
      out.push({
        predicate: REL[k],
        other,
        incoming: true,
        deleted: false,
        name: meta.name,
        description: meta.description,
        nameHistory: meta.nameHistory,
        descriptionHistory: meta.descriptionHistory,
      });
    });
    store.getQuads(null, pD, S, null).forEach((q) => {
      const other = q.subject.value;
      const meta = lookupMeta(other, baseP(DELREL[k]), uri);
      out.push({
        predicate: DELREL[k],
        other,
        incoming: true,
        deleted: true,
        name: meta.name,
        description: meta.description,
        nameHistory: meta.nameHistory,
        descriptionHistory: meta.descriptionHistory,
      });
    });
  }
  return out;
}

export default { listRelationships };
