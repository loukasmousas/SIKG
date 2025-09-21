// OntologyExtensions.js
//
// Purpose: Provide helpers for modeling relationships and their metadata using
// deterministic statement IRIs (reification) and optional verbosity for debugging.
//
// References
// - RDF Reification vocabulary: https://www.w3.org/TR/rdf-schema/#ch_reificationvocab

import pkg from 'n3';
const { DataFactory } = pkg;
const { namedNode, literal, defaultGraph } = DataFactory;
import crypto from 'crypto';
import { logger } from './logger.js';

/**
 * This module defines specialized RDF relationships: near, contains, sameObjectAs, etc.
 */
let REL_VERBOSE = process.env.PHT_VERBOSE_REL === '1';

/** Helpers for relationship naming/metadata via RDF reification */
class OntologyExtensions {
  static setVerbose(v) {
    REL_VERBOSE = !!v;
  }
  /**
   * Deterministic statement IRI for a subject–predicate–object triple, using the BASE (non-deleted) predicate.
   * Creates an md:stmt/<sha1> IRI. This is used to attach names/labels to relationships that persist across soft-deletes.
   */
  /**
   * Deterministic statement IRI for a (s, baseP, o) triple, based on sha1(s|p|o).
   * This makes metadata durable across soft‑delete toggles and re‑enables.
   * @param {string} subjectURI
   * @param {string} basePredicateURI
   * @param {string} objectURI
   * @returns {string} reified statement IRI
   */
  static stmtIRI(subjectURI, basePredicateURI, objectURI) {
    const key = `${subjectURI}|${basePredicateURI}|${objectURI}`;
    const h = crypto.createHash('sha1').update(key).digest('hex');
    // Related background: RDF reification (attaching metadata to statements)
    // https://www.w3.org/TR/rdf-schema/#ch_reificationvocab
    return `http://example.org/metadata#stmt/${h}`;
  }

  /** Attach a human-friendly name/label to a relationship (S, baseP, O) via RDF reification. */
  /** Attach a human‑friendly name/label to a relationship (S, baseP, O). */
  static setRelationshipName(
    metadataIndex,
    subjectURI,
    basePredicateURI,
    objectURI,
    name,
  ) {
    if (!name) return;
    const store = metadataIndex.store;
    const stmtIri = OntologyExtensions.stmtIRI(
      subjectURI,
      basePredicateURI,
      objectURI,
    );
    const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
    const MD = 'http://example.org/metadata#';

    // Core reification triples (idempotent add)
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDF}type`),
      namedNode(`${RDF}Statement`),
      defaultGraph(),
    );
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDF}subject`),
      namedNode(subjectURI),
      defaultGraph(),
    );
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDF}predicate`),
      namedNode(basePredicateURI),
      defaultGraph(),
    );
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDF}object`),
      namedNode(objectURI),
      defaultGraph(),
    );

    // Move previous values to history, then set current
    const prevNames = store.getQuads(
      namedNode(stmtIri),
      namedNode(`${MD}relationshipName`),
      null,
      null,
    );
    const prevLabels = store.getQuads(
      namedNode(stmtIri),
      namedNode(`${RDFS}label`),
      null,
      null,
    );
    const ts = new Date().toISOString();
    // record history for changed values (RDF + cache)
    const cacheBefore = (metadataIndex.getRelationshipMeta &&
      metadataIndex.getRelationshipMeta(stmtIri)) || {
      nameHistory: [],
      descriptionHistory: [],
    };
    let nameHistArr = Array.isArray(cacheBefore.nameHistory)
      ? cacheBefore.nameHistory.slice()
      : [];
    for (const q of prevNames) {
      if (q.object?.value && q.object.value !== String(name)) {
        store.addQuad(
          namedNode(stmtIri),
          namedNode(`${MD}relationshipNameHistory`),
          literal(`${ts}::${q.object.value}`),
          defaultGraph(),
        );
        const entry = `${ts}::${q.object.value}`;
        if (!nameHistArr.includes(entry)) nameHistArr.push(entry);
      }
    }
    for (const q of prevLabels) {
      if (q.object?.value && q.object.value !== String(name)) {
        store.addQuad(
          namedNode(stmtIri),
          namedNode(`${MD}relationshipNameHistory`),
          literal(`${ts}::${q.object.value}`),
          defaultGraph(),
        );
        const entry = `${ts}::${q.object.value}`;
        if (!nameHistArr.includes(entry)) nameHistArr.push(entry);
      }
    }
    // clear previous current values (remove all matches)
    if (typeof store.removeMatches === 'function') {
      store.removeMatches(
        namedNode(stmtIri),
        namedNode(`${MD}relationshipName`),
        null,
        null,
      );
      store.removeMatches(
        namedNode(stmtIri),
        namedNode(`${RDFS}label`),
        null,
        null,
      );
    } else {
      // fallback: removeQuads for all found quads
      store.removeQuads(prevNames);
      store.removeQuads(prevLabels);
    }
    // set current
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDFS}label`),
      literal(String(name)),
      defaultGraph(),
    );
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${MD}relationshipName`),
      literal(String(name)),
      defaultGraph(),
    );
    // also cache out-of-band for fast access (+ mirror history)
    metadataIndex.setRelationshipMeta(stmtIri, {
      name: String(name),
      nameHistory: nameHistArr,
    });
  }

  /** Remove human-friendly name/label from the reified relationship (keep core reification). */
  static clearRelationshipName(
    metadataIndex,
    subjectURI,
    basePredicateURI,
    objectURI,
  ) {
    const store = metadataIndex.store;
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
    const MD = 'http://example.org/metadata#';
    const stmtIri = OntologyExtensions.stmtIRI(
      subjectURI,
      basePredicateURI,
      objectURI,
    );
    if (process.env.DEBUG) {
      logger.info('[clearRelationshipName]', { stmtIri });
    }
    if (typeof store.removeMatches === 'function') {
      store.removeMatches(
        namedNode(stmtIri),
        namedNode(`${RDFS}label`),
        null,
        null,
      );
      store.removeMatches(
        namedNode(stmtIri),
        namedNode(`${MD}relationshipName`),
        null,
        null,
      );
    } else {
      store.removeQuads(
        store.getQuads(
          namedNode(stmtIri),
          namedNode(`${RDFS}label`),
          null,
          null,
        ),
      );
      store.removeQuads(
        store.getQuads(
          namedNode(stmtIri),
          namedNode(`${MD}relationshipName`),
          null,
          null,
        ),
      );
    }
    metadataIndex.setRelationshipMeta(stmtIri, { name: null });
  }

  /** Attach an optional description to the relationship (stored as md:relationshipDescription). */
  /** Attach a description to a relationship (S, baseP, O). */
  static setRelationshipDescription(
    metadataIndex,
    subjectURI,
    basePredicateURI,
    objectURI,
    description,
  ) {
    if (!description) return;
    const store = metadataIndex.store;
    const MD = 'http://example.org/metadata#';
    const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const stmtIri = OntologyExtensions.stmtIRI(
      subjectURI,
      basePredicateURI,
      objectURI,
    );
    // Ensure reification exists
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDF}type`),
      namedNode(`${RDF}Statement`),
      defaultGraph(),
    );
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDF}subject`),
      namedNode(subjectURI),
      defaultGraph(),
    );
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDF}predicate`),
      namedNode(basePredicateURI),
      defaultGraph(),
    );
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${RDF}object`),
      namedNode(objectURI),
      defaultGraph(),
    );
    // Move previous descriptions to history, then set current
    const prev = store.getQuads(
      namedNode(stmtIri),
      namedNode(`${MD}relationshipDescription`),
      null,
      null,
    );
    const ts = new Date().toISOString();
    const cacheBefore = (metadataIndex.getRelationshipMeta &&
      metadataIndex.getRelationshipMeta(stmtIri)) || {
      nameHistory: [],
      descriptionHistory: [],
    };
    let descHistArr = Array.isArray(cacheBefore.descriptionHistory)
      ? cacheBefore.descriptionHistory.slice()
      : [];
    for (const q of prev) {
      if (q.object?.value && q.object.value !== String(description)) {
        store.addQuad(
          namedNode(stmtIri),
          namedNode(`${MD}relationshipDescriptionHistory`),
          literal(`${ts}::${q.object.value}`),
          defaultGraph(),
        );
        const entry = `${ts}::${q.object.value}`;
        if (!descHistArr.includes(entry)) descHistArr.push(entry);
      }
    }
    // Clear previous current description(s)
    if (typeof store.removeMatches === 'function') {
      store.removeMatches(
        namedNode(stmtIri),
        namedNode(`${MD}relationshipDescription`),
        null,
        null,
      );
    } else {
      store.removeQuads(
        store.getQuads(
          namedNode(stmtIri),
          namedNode(`${MD}relationshipDescription`),
          null,
          null,
        ),
      );
    }
    // Set new current
    store.addQuad(
      namedNode(stmtIri),
      namedNode(`${MD}relationshipDescription`),
      literal(String(description)),
      defaultGraph(),
    );
    metadataIndex.setRelationshipMeta(stmtIri, {
      description: String(description),
      descriptionHistory: descHistArr,
    });
  }

  /** Remove description triple from the reified relationship (if any). */
  static clearRelationshipDescription(
    metadataIndex,
    subjectURI,
    basePredicateURI,
    objectURI,
  ) {
    const store = metadataIndex.store;
    const MD = 'http://example.org/metadata#';
    const stmtIri = OntologyExtensions.stmtIRI(
      subjectURI,
      basePredicateURI,
      objectURI,
    );
    if (process.env.DEBUG) {
      logger.info('[clearRelationshipDescription]', { stmtIri });
    }
    if (typeof store.removeMatches === 'function') {
      store.removeMatches(
        namedNode(stmtIri),
        namedNode(`${MD}relationshipDescription`),
        null,
        null,
      );
    } else {
      store.removeQuads(
        store.getQuads(
          namedNode(stmtIri),
          namedNode(`${MD}relationshipDescription`),
          null,
          null,
        ),
      );
    }
    metadataIndex.setRelationshipMeta(stmtIri, { description: null });
  }
  /**
   * Insert a "near" relationship: region A near region B
   */
  static insertNearRelationship(metadataIndex, uriA, uriB) {
    if (REL_VERBOSE)
      logger.info(`Inserting NEAR relationship: ${uriA} near ${uriB}`);
    const store = metadataIndex.store;
    store.addQuad(
      namedNode(uriA),
      namedNode('http://example.org/metadata#near'),
      namedNode(uriB),
      defaultGraph(),
    );
  }

  /**
   * Insert "contains": region A contains region B
   */
  static insertContainsRelationship(metadataIndex, uriA, uriB) {
    if (REL_VERBOSE)
      logger.info(`Inserting CONTAINS: ${uriA} contains ${uriB}`);
    const store = metadataIndex.store;
    store.addQuad(
      namedNode(uriA),
      namedNode('http://example.org/metadata#contains'),
      namedNode(uriB),
      defaultGraph(),
    );
  }

  /**
   * Insert "sameObjectAs": region A is the same object as region B
   */
  static insertSameObjectAs(metadataIndex, uriA, uriB) {
    if (REL_VERBOSE)
      logger.info(`Inserting SAME_OBJECT_AS: ${uriA} same as ${uriB}`);
    const store = metadataIndex.store;
    store.addQuad(
      namedNode(uriA),
      namedNode('http://example.org/metadata#sameObjectAs'),
      namedNode(uriB),
      defaultGraph(),
    );
  }

  /** overlap (non-contained intersection with area threshold) */
  static insertOverlaps(metadataIndex, uriA, uriB) {
    const store = metadataIndex.store;
    store.addQuad(
      namedNode(uriA),
      namedNode('http://example.org/metadata#overlaps'),
      namedNode(uriB),
      defaultGraph(),
    );
  }

  /** edge touch (share border but minimal area intersection) */
  static insertIntersectsEdge(metadataIndex, uriA, uriB) {
    const store = metadataIndex.store;
    store.addQuad(
      namedNode(uriA),
      namedNode('http://example.org/metadata#intersectsEdge'),
      namedNode(uriB),
      defaultGraph(),
    );
  }

  /** inside with ratio triple */
  static insertInsideWithRatio(metadataIndex, innerURI, outerURI, ratio) {
    const store = metadataIndex.store;
    const _bn = `_:inside_${Math.random().toString(36).slice(2)}`; // currently unused blank node id
    store.addQuad(
      namedNode(innerURI),
      namedNode('http://example.org/metadata#inside'),
      namedNode(outerURI),
      defaultGraph(),
    );
    store.addQuad(
      namedNode(innerURI),
      namedNode('http://example.org/metadata#insideRatio'),
      literal(String(ratio)),
      defaultGraph(),
    );
  }

  /**
   * Link a Region to the ML model that produced it.
   *   <regionURI>  md:detectedBy   <modelURI> .
   */
  static insertDetectedByRelationship(metadataIndex, regionURI, modelURI) {
    logger.info(`Inserting DETECTED_BY: ${regionURI} → ${modelURI}`);
    const store = metadataIndex.store;

    // provenance triple
    store.addQuad(
      namedNode(regionURI),
      namedNode('http://example.org/metadata#detectedBy'),
      namedNode(modelURI),
      defaultGraph(),
    );

    // give the model a readable rdfs:label once
    const hasLabel =
      store.getQuads(
        namedNode(modelURI),
        namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
        null,
        null,
      ).length > 0;

    if (!hasLabel) {
      const label = modelURI.split('#').pop();
      store.addQuad(
        namedNode(modelURI),
        namedNode('http://www.w3.org/2000/01/rdf-schema#label'),
        literal(label),
        defaultGraph(),
      );
    }
  }
}

export default OntologyExtensions;
