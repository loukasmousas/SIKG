// MetadataIndex.js
//
// Purpose: Central metadata/RDF layer for the app. Maintains two synchronized views:
//  1) An N3 in‑memory RDF store for standards‑compliant queries via Comunica (SPARQL)
//  2) A hash‑table index mapping sha256(URI) -> UI‑oriented metadata for fast lookups
//
// Design notes
// - Hashing URIs avoids problematic JSON object keys and yields fixed‑length, cache‑friendly keys.
//   Cryptographic collision probability for SHA‑256 is negligible for the scale.
// - Relationship metadata (names/descriptions + histories) is kept in a Map keyed by a deterministic
//   statement IRI (see OntologyExtensions.stmtIRI) to persist across soft‑deletes.
// - SPARQL executes against an RDF/JS Source adapter wrapping the N3 store.
//
// References
// - RDF concepts (W3C): https://www.w3.org/TR/rdf11-concepts/
// - SPARQL 1.1 Query Language (W3C): https://www.w3.org/TR/sparql11-query/
// - Comunica RDF/JS querying: https://comunica.dev/docs/query/advanced/rdfjs_querying/

import crypto from 'crypto';
import { DataFactory, Parser, Store, Writer } from 'n3';
import { QueryEngine } from '@comunica/query-sparql';
import { Readable } from 'stream';
import { logger } from './logger.js';

const { namedNode, literal, quad, defaultGraph } = DataFactory; // quad used for store.addQuad

class N3StoreRdfJsSource {
  constructor(store) {
    this.store = store;
  }

  match(subject, predicate, object, graph) {
    const quadIterator = this.store.match(subject, predicate, object, graph);

    // Create a Node.js Readable stream from the quad iterator
    // Similar approach: Querying RDF/JS sources with Comunica
    // https://comunica.dev/docs/query/advanced/rdfjs_querying/
    return Readable.from(quadIterator);
  }
}

// Earlier attempts at N3StoreRdfJsSource implementations, kept to show struggles:
// class N3StoreRdfJsSource {
//     constructor(store) {
//         this.store = store;
//     }

//     match(subject, predicate, object, graph) {
//         const quadIterator = this.store.match(subject, predicate, object, graph);

//         // Convert the synchronous iterator into an array
//         const quadsArray = Array.from(quadIterator);

//         // Create a Node.js Readable stream from the quads array
//         return Readable.from(quadsArray);
//     }
// }

// class N3StoreRdfJsSource {
//     constructor(store) {
//         this.store = store;
//     }

//     match(subject, predicate, object, graph) {
//         const quadIterator = this.store.match(subject, predicate, object, graph);

//         // Convert synchronous iterator to async iterator
//         async function* asyncIterator() {
//             for (const quad of quadIterator) {
//                 yield quad;
//             }
//         }

//         return asyncIterator();
//     }
// }

class MetadataIndex {
  constructor() {
    this.index = {}; // Key: Hashed URI, Value: Metadata
    this.store = new Store(); // RDF Store
    this.relMeta = new Map(); // key: stmtIri -> { name, description, nameHistory:[], descriptionHistory:[] }
    // attach for consumers who only receive the store
    this.store.relMeta = this.relMeta;
  }

  /**
   * Ensure every subject with a uri://<image>/... identity (or md:uri value) has ex:within <urn:image:<image>>.
   * Safe to call multiple times; idempotent.
   */
  /**
   * Ensure every subject with a uri://<image>/... identity (or md:uri value)
   * has ex:within <urn:image:<image>>. Idempotent; safe to call multiple times.
   */
  ensureImageScoping() {
    const MD = 'http://example.org/metadata#';
    const EX = 'http://example.org/';
    const WITHIN = namedNode(`${EX}within`);
    // Pass 1: from md:uri literal values
    try {
      const mdUri = namedNode(`${MD}uri`);
      const mdUriQuads = this.store.getQuads(null, mdUri, null, null);
      for (const q of mdUriQuads) {
        const subj = q.subject;
        const val = String(q.object.value || '');
        const m = val.match(/^uri:\/\/([^/\s]+)\//);
        if (!m) continue;
        const imgIri = namedNode(`urn:image:${m[1]}`);
        const has = this.store.getQuads(subj, WITHIN, null, null).length > 0;
        if (!has) this.store.addQuad(quad(subj, WITHIN, imgIri));
      }
    } catch {
      // best-effort; ignore inference errors
    }
    // Pass 2: by subject IRIs directly
    try {
      const all = this.store.getQuads(null, null, null, null);
      const seen = new Set();
      for (const q of all) {
        const s = q.subject;
        if (!s || s.termType !== 'NamedNode') continue;
        const iri = s.value;
        if (!iri.startsWith('uri://')) continue;
        if (seen.has(iri)) continue;
        seen.add(iri);
        const m = iri.match(/^uri:\/\/([^/\s]+)\//);
        if (!m) continue;
        const imgIri = namedNode(`urn:image:${m[1]}`);
        const has =
          this.store.getQuads(s, namedNode(`${EX}within`), null, null).length >
          0;
        if (!has) this.store.addQuad(quad(s, namedNode(`${EX}within`), imgIri));
      }
    } catch {
      // best-effort; ignore inference errors
    }
  }

  setRelationshipMeta(stmtIri, partial) {
    const cur = this.relMeta.get(stmtIri) || {
      name: null,
      description: null,
      nameHistory: [],
      descriptionHistory: [],
    };
    const next = { ...cur, ...partial };
    this.relMeta.set(stmtIri, next);
  }

  getRelationshipMeta(stmtIri) {
    return this.relMeta.get(stmtIri) || null;
  }

  /**
   * Convenience: append an arbitrary Turtle fragment to the store.
   * Example:
   *   metadataIndex.insertQuads(`
   *       <urn:test:s> a <http://example.org/Foo> ;
   *                    <http://example.org/bar> "42"^^xsd:double .
   *   `);
   */
  insertQuads(turtleString) {
    const p = new Parser({ baseIRI: 'http://example.org/' });
    const quads = p.parse(turtleString);
    this.store.addQuads(quads);
  }

  /** converts “traffic light” → traffic_light and strips odd chars */
  /** converts “traffic light” → traffic_light and strips odd chars */
  static safeLocalName(str) {
    return str
      .toLowerCase()
      .replace(/\s+/g, '_') // spaces → _
      .replace(/[^a-z0-9_]/g, ''); // drop anything not NCName-safe
  }

  /**
   * Compute SHA‑256 of a URI string (hex).
   * Similar to Node.js crypto hashing examples:
   * https://nodejs.org/api/crypto.html#class-hash
   * @param {String} uri
   * @returns {String}
   */
  hashURI(uri) {
    return crypto.createHash('sha256').update(uri).digest('hex');
  }

  /**
   * Inserts metadata for a given type and identifier.
   * Also adds RDF triples to the store.
   * @param {String} type - e.g., 'pixel' or 'region'
   * @param {String} imageName
   * @param {Object} identifier - e.g., { x, y } or { regionId }
   * @param {Object} metadata
   */
  /**
   * Insert/update a metadata entry and emit triples into the RDF store.
   * @param {('pixel'|'region'|string)} type
   * @param {String} imageName
   * @param {Object} identifier - e.g. {x,y} for pixel or {regionId}
   * @param {Object} metadata - arbitrary UI‑centric fields (stored under md:* predicates)
   * @param {String} pipelineSegment - e.g., 'singleImage' | 'tiledImage'
   */
  insert(type, imageName, identifier, metadata, pipelineSegment) {
    // unified scheme: uri://<imageName>/<pipelineSegment>/<id>
    let key;
    if (type === 'pixel') {
      key = `uri://${imageName}/pixel/${identifier.x}/${identifier.y}`;
    } else if (type === 'region') {
      const seg = pipelineSegment || 'singleImage';
      key = `uri://${imageName}/${seg}/${identifier.regionId}`;
    } else {
      key = `uri://${imageName}/${type}/`;
    }

    // Hash the URI key
    const hashedKey = this.hashURI(key);
    this.index[hashedKey] = metadata;

    // Add RDF triples
    const subject = namedNode(key);
    for (const [prop, value] of Object.entries(metadata)) {
      const predicate = namedNode(`http://example.org/metadata#${prop}`);
      if (Array.isArray(value)) {
        value.forEach((v) => {
          const object = literal(v);
          this.store.addQuad(quad(subject, predicate, object, defaultGraph()));
        });
      } else {
        let object;
        if (typeof value === 'number') {
          object = literal(
            value.toString(),
            namedNode('http://www.w3.org/2001/XMLSchema#decimal'),
          );
        } else {
          object = literal(value);
        }
        this.store.addQuad(quad(subject, predicate, object, defaultGraph()));
      }
    }
  }

  /**
   * Searches metadata by URI.
   * @param {String} uri
   * @returns {Object|null}
   */
  /**
   * Get metadata by canonical URI via the hash index.
   * @param {String} uri
   * @returns {Object|null}
   */
  searchURI(uri) {
    const hashedKey = this.hashURI(uri);
    return this.index[hashedKey] || null;
  }

  /**
   * Serializes the MetadataIndex to JSON.
   * @returns {Object}
   */
  /**
   * Serialize RDF store to Turtle and return a JSON snapshot consumable by Serializer.
   * @returns {Promise<{index:Object, rdf:string, relMeta:Object}>}
   */
  async toJSON() {
    const writer = new Writer({ format: 'text/turtle' });
    const quads = this.store.getQuads(null, null, null, null);
    const turtle = await new Promise((resolve, reject) => {
      writer.addQuads(quads);
      writer.end((error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
    // Serialize relationship meta cache as plain object
    const relMetaObj = {};
    if (this.relMeta && this.relMeta.size) {
      for (const [k, v] of this.relMeta.entries()) {
        relMetaObj[k] = {
          name: v?.name ?? null,
          description: v?.description ?? null,
          nameHistory: Array.isArray(v?.nameHistory) ? v.nameHistory : [],
          descriptionHistory: Array.isArray(v?.descriptionHistory)
            ? v.descriptionHistory
            : [],
        };
      }
    }
    return {
      index: this.index,
      rdf: turtle,
      relMeta: relMetaObj,
    };
  }

  /**
   * Deserializes JSON data to a MetadataIndex instance.
   * @param {Object} json
   * @returns {Promise<MetadataIndex>}
   */
  /**
   * Rehydrate a MetadataIndex from a Serializer JSON snapshot.
   * @param {Object} json
   * @returns {Promise<MetadataIndex>}
   */
  static async fromJSON(json) {
    const instance = new MetadataIndex();
    instance.index = json.index || {};

    // Parse RDF data and add to store
    const parser = new Parser();
    return new Promise((resolve, reject) => {
      parser.parse(json.rdf, (error, quad) => {
        if (error) reject(error);
        else if (quad) instance.store.addQuad(quad);
        else {
          // Rehydrate relationship meta cache
          instance.relMeta = new Map();
          const relMeta = json.relMeta || {};
          for (const [k, v] of Object.entries(relMeta)) {
            instance.relMeta.set(k, {
              name: v?.name ?? null,
              description: v?.description ?? null,
              nameHistory: Array.isArray(v?.nameHistory) ? v.nameHistory : [],
              descriptionHistory: Array.isArray(v?.descriptionHistory)
                ? v.descriptionHistory
                : [],
            });
          }
          // attach for consumers of the bare store
          instance.store.relMeta = instance.relMeta;

          // Inject missing md:relationshipName/Description triples from relMeta cache
          try {
            const MD = 'http://example.org/metadata#';
            const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
            const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
            for (const [stmtIri, v] of instance.relMeta.entries()) {
              const sNN = namedNode(stmtIri);
              // ensure core reification exists minimally (type only if absent)
              const hasAny =
                instance.store.getQuads(sNN, null, null, null).length > 0;
              if (!hasAny) {
                instance.store.addQuad(
                  sNN,
                  namedNode(`${RDF}type`),
                  namedNode(`${RDF}Statement`),
                );
              }
              if (v?.name) {
                const exists =
                  instance.store.getQuads(
                    sNN,
                    namedNode(`${MD}relationshipName`),
                    null,
                    null,
                  ).length > 0 ||
                  instance.store.getQuads(
                    sNN,
                    namedNode(`${RDFS}label`),
                    null,
                    null,
                  ).length > 0;
                if (!exists) {
                  instance.store.addQuad(
                    sNN,
                    namedNode(`${MD}relationshipName`),
                    literal(String(v.name)),
                  );
                  instance.store.addQuad(
                    sNN,
                    namedNode(`${RDFS}label`),
                    literal(String(v.name)),
                  );
                }
              }
              if (v?.description) {
                const exists =
                  instance.store.getQuads(
                    sNN,
                    namedNode(`${MD}relationshipDescription`),
                    null,
                    null,
                  ).length > 0;
                if (!exists) {
                  instance.store.addQuad(
                    sNN,
                    namedNode(`${MD}relationshipDescription`),
                    literal(String(v.description)),
                  );
                }
              }
            }
          } catch (_e) {
            // best-effort; leave store as-is on error
          }

          // General inference: add ex:within <urn:image:...> for any subject with md:uri "uri://<image>/..." if missing
          try {
            const MD = 'http://example.org/metadata#';
            const EX = 'http://example.org/';
            const WITHIN = namedNode(`${EX}within`);
            const mdUri = namedNode(`${MD}uri`);
            const mdUriQuads = instance.store.getQuads(null, mdUri, null, null);
            for (const q of mdUriQuads) {
              const subj = q.subject;
              const val = String(q.object.value || '');
              if (val.startsWith('uri://')) {
                // extract between uri:// and next /
                const rest = val.slice('uri://'.length);
                const imageName = rest.split('/')[0];
                if (imageName) {
                  const imgIri = namedNode(`urn:image:${imageName}`);
                  const hasWithin =
                    instance.store.getQuads(subj, WITHIN, null, null).length >
                    0;
                  if (!hasWithin)
                    instance.store.addQuad(quad(subj, WITHIN, imgIri));
                }
              }
            }
            // Also add ex:within by inspecting subject IRIs directly: uri://<image>/...
            const all = instance.store.getQuads(null, null, null, null);
            const seen = new Set();
            for (const q of all) {
              const s = q.subject;
              if (!s || s.termType !== 'NamedNode') continue;
              const iri = s.value;
              if (!iri.startsWith('uri://')) continue;
              if (seen.has(iri)) continue;
              seen.add(iri);
              const m = iri.match(/^uri:\/\/([^/\s]+)\//);
              if (!m) continue;
              const imgIri = namedNode(`urn:image:${m[1]}`);
              const hasWithin =
                instance.store.getQuads(s, WITHIN, null, null).length > 0;
              if (!hasWithin) instance.store.addQuad(quad(s, WITHIN, imgIri));
            }
          } catch (_e) {
            // ignore ex:within inference errors
          }
          // Final safety: ensure image scoping idempotently for any remaining subjects
          try {
            if (typeof instance.ensureImageScoping === 'function') {
              instance.ensureImageScoping();
            }
          } catch {
            // ignore
          }
          resolve(instance);
        }
      });
    });
  }

  /**
   * Executes a SPARQL query on the RDF store using Comunica.
   * @param {String} query - The SPARQL query string.
   * @returns {Promise<Array>} - Query results.

          // Generic image scoping: ensure ex:within for any subject with md:uri "uri://<image>/..."
          try {
            const MD = 'http://example.org/metadata#';
            const EXW = 'http://example.org/within';
            const WITHIN = namedNode(EXW);
            const uriQuads = instance.store.getQuads(
              null,
              namedNode(`${MD}uri`),
              null,
              null,
            );
            for (const q of uriQuads) {
              const subj = q.subject;
              const val = String(q.object.value || '');
              // Expect forms like uri://<image>/<segment>/<id>
              const m = val.match(/^uri:\/\/([^\/\s]+)\//);
              if (!m) continue;
              const imageName = m[1];
              const imgIri = namedNode(`urn:image:${imageName}`);
              const hasWithin =
                instance.store.getQuads(subj, WITHIN, null, null).length > 0;
              if (!hasWithin) instance.store.addQuad(quad(subj, WITHIN, imgIri));
            }
            // Also consider any subject that carries md:tags or md:classLabel and has a uri://<image>/... subject IRI
            const TAGS = namedNode(`${MD}tags`);
            const CLASSLABEL = namedNode(`${MD}classLabel`);
            const tagSubs = instance.store.getQuads(null, TAGS, null, null);
            const clSubs = instance.store.getQuads(null, CLASSLABEL, null, null);
            const subs = new Set([...tagSubs, ...clSubs].map((q) => q.subject.value));
            for (const s of subs) {
              if (!/^uri:\/\//.test(s)) continue;
              const m = s.match(/^uri:\/\/([^\/\s]+)\//);
              if (!m) continue;
              const subj = namedNode(s);
              const imgIri = namedNode(`urn:image:${m[1]}`);
              const hasWithin =
                instance.store.getQuads(subj, WITHIN, null, null).length > 0;
              if (!hasWithin) instance.store.addQuad(quad(subj, WITHIN, imgIri));
            }
            // Fallback: also inspect subject IRIs directly for uri://<image>/... resources
            const allQuads = instance.store.getQuads(null, null, null, null);
            const seen = new Set();
            for (const q of allQuads) {
              const subj = q.subject;
              if (!subj || typeof subj.value !== 'string') continue;
              const s = subj.value;
              if (!s.startsWith('uri://')) continue;
              if (seen.has(s)) continue;
              seen.add(s);
              const m = s.match(/^uri:\/\/([^\/\s]+)\//);
              if (!m) continue;
              const imageName = m[1];
              const imgIri = namedNode(`urn:image:${imageName}`);
              const hasWithin =
                instance.store.getQuads(subj, WITHIN, null, null).length > 0;
              if (!hasWithin) instance.store.addQuad(quad(subj, WITHIN, imgIri));
            }
          } catch (_e) {
            // ignore
          }
   */
  /**
   * Execute a SPARQL SELECT on the in‑memory RDF store via Comunica.
   * @param {String} query
   * @returns {Promise<Array>} array of bindings
   */
  async executeSPARQL(query) {
    logger.info('Executing SPARQL Query:', query);
    const engine = new QueryEngine();

    // Wrap the N3Store into an RDF/JS Source
    const rdfjsSource = new N3StoreRdfJsSource(this.store);

    const context = {
      sources: [rdfjsSource],
    };
    logger.info('Context:', context);

    logger.info('Number of quads in store:', this.store.size);

    // Use queryBindings() to get the bindings stream directly
    const bindingsStream = await engine.queryBindings(query, context);

    logger.info('Received bindings stream.');

    const bindings = [];

    // Use async iterator to consume the stream
    for await (const binding of bindingsStream) {
      bindings.push(binding);
    }

    logger.info('Finished processing bindings.');
    return bindings;
  }
}

export const safeLocalName = MetadataIndex.safeLocalName; // one-liner helper export
export default MetadataIndex;
