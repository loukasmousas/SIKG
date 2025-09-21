// InteractiveViewerServer.js

import 'dotenv/config'; // load .env early (PORT, PHT_SLIM_JSON, etc.)
import '../common/env-logging.js'; // silence logs unless DEBUG is set
import { logger } from '../common/logger.js';
//
// Endpoints overview (categories)
// - Manifests & tiles: GET /images.json, GET /loadImage, GET /getTile, GET /export/ttl, GET /health
// - Relationships & SPARQL: GET /relationships, POST /sparql
// - Global registry: POST /global/load, POST /global/sparql, POST /global/regions, GET /global/crop
// - Clusters & curation: POST /global/cluster, POST /global/uncluster, GET /global/cluster/list,
//   POST /global/cluster/meta, POST /global/cluster/link, POST /global/cluster/delete, POST /global/rel
// - Usability & voice: POST /ux/event, POST /nl2sparql/text
// - Highlights: POST /highlight
import os from 'os';
import http from 'http';
import { Server } from 'socket.io';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import sharp from 'sharp';
import { QueryEngine } from '@comunica/query-sparql';
import TiledMLSerializer from '../tiled/TiledMLSerializer.js';
import Serializer from '../common/Serializer.js';
import GlobalRegistry from '../global/GlobalRegistry.js';
import RegionManager from '../common/RegionManager.js';
import MetadataIndex from '../common/MetadataIndex.js';
import OntologyExt from '../common/OntologyExtensions.js';
import { bufferToSPARQL } from '../voice/VoiceService.js';
import { listRelationships } from '../common/Relationships.js';
import { ensureDefaultSlimJson } from '../common/env-defaults.js';

// Viewer logs current slimming mode (does not override explicit user setting)
ensureDefaultSlimJson('Viewer');

import { DataFactory, Writer } from 'n3';
const { namedNode, literal, quad } = DataFactory;

/* ─── helpers ─────────────────────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const INPUT_DIR = path.join(process.cwd(), 'input-images'); // using input-images
const OUT_DIR = path.join(process.cwd(), 'output'); // JSON, TTL, tiles etc.
const qe = new QueryEngine();

const imgPrefix = (p) => path.basename(p, '.json') || 'myImage';
const unifyId = (id) =>
  String(id).match(/^region-\d+|manual-\d+$/) ? String(id) : `region-${id}`;

// Relationship predicates – shared constants
import { REL, DELREL, ALL_REL_P, toKey } from '../common/rel-const.js';

// Helper: snapshot + update relationship meta (name/description) and mirror history into cache
// Semantics:
// - If name/description provided as strings: non-empty → set; empty → clear.
// - Adds a timestamped "prev value" to nameHistory/descriptionHistory in relMeta cache when the value changes.
function updateRelMetaWithHistory(mi, subj, basePred, obj, nameOpt, descOpt) {
  try {
    const stmtIri = OntologyExt.stmtIRI(subj, basePred, obj);
    const prevCached = mi.getRelationshipMeta
      ? mi.getRelationshipMeta(stmtIri)
      : null;
    const prevName = prevCached?.name ?? null;
    const prevDesc = prevCached?.description ?? null;
    const prevNameHist = Array.isArray(prevCached?.nameHistory)
      ? prevCached.nameHistory.slice()
      : [];
    const prevDescHist = Array.isArray(prevCached?.descriptionHistory)
      ? prevCached.descriptionHistory.slice()
      : [];

    if (typeof nameOpt === 'string') {
      const v = nameOpt.trim();
      if (v) OntologyExt.setRelationshipName(mi, subj, basePred, obj, v);
      else OntologyExt.clearRelationshipName(mi, subj, basePred, obj);
    }
    if (typeof descOpt === 'string') {
      const v = descOpt.trim();
      if (v) OntologyExt.setRelationshipDescription(mi, subj, basePred, obj, v);
      else OntologyExt.clearRelationshipDescription(mi, subj, basePred, obj);
    }

    // Mirror cache history if changed
    const nowIso = new Date().toISOString();
    if (
      typeof nameOpt === 'string' &&
      prevName &&
      nameOpt.trim() &&
      nameOpt.trim() !== prevName
    ) {
      const entry = `${nowIso}::${prevName}`;
      const set = new Set(prevNameHist);
      set.add(entry);
      mi.setRelationshipMeta?.(stmtIri, { nameHistory: [...set] });
    }
    if (
      typeof descOpt === 'string' &&
      prevDesc &&
      descOpt.trim() &&
      descOpt.trim() !== prevDesc
    ) {
      const entry = `${nowIso}::${prevDesc}`;
      const set = new Set(prevDescHist);
      set.add(entry);
      mi.setRelationshipMeta?.(stmtIri, { descriptionHistory: [...set] });
    }
  } catch (err) {
    logger.warn('relationship history update failed', err);
  }
}

const normaliseRM = (rm, prefix, pipelineSegment) =>
  rm.regions.forEach((r) => {
    if (!r.metadata) r.metadata = {};
    if (!/^manual-|^region-/.test(r.id)) r.id = unifyId(r.id);
    if (!r.metadata.uri) {
      // manual annotations keep dedicated segment for clarity
      const seg = r.id.startsWith('manual-')
        ? 'manual-region'
        : pipelineSegment;
      r.metadata.uri = `uri://${prefix}/${seg}/${r.id}`;
    }
    // Ensure an ex:within triple exists for every region (manual or auto)
    try {
      const subj = namedNode(r.metadata.uri);
      const WITHIN = namedNode('http://example.org/within');
      const imgIri = namedNode(`urn:image:${prefix}`);
      if (state?.metadataIndex?.store) {
        const has = state.metadataIndex.store.getQuads(
          subj,
          WITHIN,
          null,
          null,
        ).length;
        if (!has) state.metadataIndex.store.addQuad(quad(subj, WITHIN, imgIri));
      }
    } catch (_) {
      // ignore: store not yet initialised
    }
  });

/* ─── express / socket.io setup ───────────────────────────── */
// Similar integration: Express + Socket.IO server setup
// https://socket.io/how-to/use-with-express
// Express + Socket.IO server setup
// https://socket.io/docs/v4/server-initialization/#with-express
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// Debounced manifest persistence
let saveTimer = null;
async function saveState() {
  try {
    if (!state.currentJsonPath) return;
    if (process.env.DEBUG) {
      const MD = 'http://example.org/metadata#';
      const beforeN = state.metadataIndex.store.getQuads(
        null,
        namedNode(`${MD}relationshipName`),
        null,
        null,
      ).length;
      const beforeD = state.metadataIndex.store.getQuads(
        null,
        namedNode(`${MD}relationshipDescription`),
        null,
        null,
      ).length;
      logger.info('[saveState] before save counts', { beforeN, beforeD });
    }
    if (state.isTiled)
      await TiledMLSerializer.save(
        state.loadedTiles,
        state.metadataIndex,
        state.regionManager,
        state.currentJsonPath,
      );
    else
      await new Serializer(
        state.pixelMatrix,
        state.metadataIndex,
        state.regionManager,
      ).save(state.currentJsonPath);
    if (process.env.DEBUG) {
      const MD = 'http://example.org/metadata#';
      const afterN = state.metadataIndex.store.getQuads(
        null,
        namedNode(`${MD}relationshipName`),
        null,
        null,
      ).length;
      const afterD = state.metadataIndex.store.getQuads(
        null,
        namedNode(`${MD}relationshipDescription`),
        null,
        null,
      ).length;
      logger.info('[saveState] after save counts', { afterN, afterD });
    }
    logger.info('autosaved', path.basename(state.currentJsonPath));
  } catch (_e) {
    logger.warn('autosave failed', _e.message);
  }
}
function scheduleSave() {
  globalThis.clearTimeout?.(saveTimer);
  saveTimer = setTimeout(() => {
    saveState();
  }, 250);
}

app.use(express.static(path.join(process.cwd(), 'public')));
app.use('/imgs', express.static(INPUT_DIR)); // Serve raw from input-images
app.use('/tiles', express.static(OUT_DIR)); // Serve generated tiles

app.use(express.text({ type: 'text/plain' })); // For SPARQL endpoint

// Usability instrumentation route
app.post('/ux/event', express.json(), (req, res) => {
  try {
    const dir = path.join(process.cwd(), 'output', 'eval');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), ...(req.body || {}) });
    fs.appendFileSync(path.join(dir, 'usability_events.jsonl'), line + '\n');
    res.json({ ok: true });
  } catch (_e) {
    res.status(500).json({ ok: false, error: _e.message });
  }
});

// Serve the viewer explicitly at root (avoids any static edge cases)
app.get('/', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// Lightweight health check (feature set 1)
app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Number(process.uptime().toFixed(1)) });
});

// Helper: serialize an N3 store to Turtle with helpful prefixes
async function storeToTTL(store) {
  const writer = new Writer({
    format: 'text/turtle',
    prefixes: {
      ex: 'http://example.org/',
      md: 'http://example.org/metadata#',
      rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      xsd: 'http://www.w3.org/2001/XMLSchema#',
    },
  });
  const quads = store.getQuads(null, null, null, null);
  return new Promise((resolve, reject) => {
    try {
      writer.addQuads(quads);
      writer.end((err, result) => (err ? reject(err) : resolve(result)));
    } catch (_e2) {
      reject(_e2);
    }
  });
}

/* ─── mutable session state ───────────────────────────────── */
let state = {
  isTiled: false,
  loadedTiles: [],
  pixelMatrix: null,
  regionManager: new RegionManager(),
  metadataIndex: new MetadataIndex(),
  currentJsonPath: null,
  imagePrefix: 'myImage',
  uriToRegionId: new Map(), // maps any region URI (original or merged source) -> canonical region id
  uriToBoundary: new Map(), // maps any region URI -> canonical boundary
};

/* ─── global registry (merged multi-image state) ───────────────────── */
const globalState = {
  registry: null, // GlobalRegistry instance
  uriToRegionId: new Map(),
  uriToBoundary: new Map(),
};

function rebuildGlobalUriMaps() {
  globalState.uriToRegionId = new Map();
  globalState.uriToBoundary = new Map();
  if (!globalState.registry || !globalState.registry.regionManager) return;
  const rm = globalState.registry.regionManager;
  const store = globalState.registry.metadataIndex?.store;
  // direct regions
  rm.regions.forEach((r) => {
    const uri = r.metadata?.uri;
    if (!uri) return;
    globalState.uriToRegionId.set(uri, r.id);
    globalState.uriToBoundary.set(uri, r.boundary);
  });
  // mergedFrom triples: <target> ex:mergedFrom <src>
  try {
    const MERGED_FROM = 'http://example.org/mergedFrom';
    store
      ?.getQuads(null, null, null, null)
      .filter((q) => q.predicate.value === MERGED_FROM)
      .forEach((q) => {
        const target = q.subject.value;
        const src = q.object.value;
        const rid = globalState.uriToRegionId.get(target);
        const b = globalState.uriToBoundary.get(target);
        if (rid != null) {
          globalState.uriToRegionId.set(src, rid);
          if (b) globalState.uriToBoundary.set(src, b);
        }
      });
  } catch (_) {
    // ignore
  }
}

function instrumentStore(store) {
  if (!process.env.DEBUG) return;
  try {
    const MD = 'http://example.org/metadata#'; // reuse constant name scoped to this block
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
    const isMetaPred = (p) =>
      p &&
      (p.value === `${MD}relationshipName` ||
        p.value === `${MD}relationshipDescription` ||
        p.value === `${RDFS}label`);
    const origRemoveMatches = store.removeMatches?.bind(store);
    if (origRemoveMatches) {
      store.removeMatches = function (s, p, o, g) {
        const candidates = store.getQuads(
          s || null,
          p || null,
          o || null,
          g || null,
        );
        const meta = candidates.filter((q) => isMetaPred(q.predicate));
        if (meta.length) {
          logger.warn(
            '[STORE removeMatches] removing meta quads',
            meta.map(
              (q) =>
                `${q.subject.value} ${q.predicate.value} ${q.object.value}`,
            ),
          );
        }
        return origRemoveMatches(s, p, o, g);
      };
    }
    const origRemoveQuad = store.removeQuad?.bind(store);
    if (origRemoveQuad) {
      store.removeQuad = function (...args) {
        const q = args[0];
        if (q && isMetaPred(q.predicate)) {
          logger.warn(
            '[STORE removeQuad] removing meta quad',
            `${q.subject.value} ${q.predicate.value} ${q.object.value}`,
          );
        }
        return origRemoveQuad(...args);
      };
    }
    const origRemoveQuads = store.removeQuads?.bind(store);
    if (origRemoveQuads) {
      store.removeQuads = function (quads) {
        const meta = (quads || []).filter((q) => isMetaPred(q.predicate));
        if (meta.length) {
          logger.warn(
            '[STORE removeQuads] removing meta quads',
            meta.map(
              (q) =>
                `${q.subject.value} ${q.predicate.value} ${q.object.value}`,
            ),
          );
        }
        return origRemoveQuads(quads);
      };
    }
  } catch (_e) {
    logger.warn('store instrumentation failed', _e.message);
  }
}

// Instrument initial store
instrumentStore(state.metadataIndex.store);

function rebuildUriMaps() {
  state.uriToRegionId = new Map();
  state.uriToBoundary = new Map();
  // direct regions
  state.regionManager.regions.forEach((r) => {
    const uri = r.metadata?.uri;
    if (!uri) return;
    state.uriToRegionId.set(uri, r.id);
    state.uriToBoundary.set(uri, r.boundary);
  });
  // mergedFrom triples: <target> ex:mergedFrom <src>
  const MERGED_FROM = 'http://example.org/mergedFrom';
  state.metadataIndex.store
    .getQuads(null, null, null, null)
    .filter((q) => q.predicate.value === MERGED_FROM)
    .forEach((q) => {
      const target = q.subject.value;
      const src = q.object.value;
      const rid = state.uriToRegionId.get(target);
      const b = state.uriToBoundary.get(target);
      if (rid != null) {
        state.uriToRegionId.set(src, rid);
        if (b) state.uriToBoundary.set(src, b);
      }
    });
}

/* ═══════════════════════════════════════════════════════════
   helper: merge JSON + (re)write only *edited* md: triples
   ═════════════════════════════════════════════════════════ */
function upsert(uri, patch /* obj containing ONLY edited props */) {
  /* merge into hash table ----------------------------------------- */
  const idx = state.metadataIndex;
  const h = idx.hashURI(uri);
  idx.index[h] = { ...idx.index[h], ...patch };

  /* rebuild *only* the md:property triples we touched -------------- */
  const propsWeSet = new Set(Object.keys(patch));
  const subj = namedNode(uri);

  idx.store
    .getQuads(subj, null, null, null) // iterate existing triples
    .filter(
      (q) =>
        q.predicate.value.startsWith('http://example.org/metadata#') &&
        propsWeSet.has(q.predicate.value.split('#').pop()),
    )
    .forEach((q) => idx.store.removeQuad(q)); // remove those props

  for (const [prop, val] of Object.entries(patch)) {
    // (re)insert new values
    if (prop === 'deleted') continue; // flag only in JSON
    const pred = namedNode(`http://example.org/metadata#${prop}`);
    (Array.isArray(val) ? val : [val]).forEach((v) => {
      const obj =
        typeof v === 'number'
          ? literal(
              v.toString(),
              namedNode('http://www.w3.org/2001/XMLSchema#decimal'),
            )
          : literal(v);
      idx.store.addQuad(quad(subj, pred, obj));
    });
  }
}

/* ═══════════════════════════════════════════════════════════
   /images.json – return list of thumbnails from input-images
   ═════════════════════════════════════════════════════════ */
app.get('/images.json', async (_req, res) => {
  try {
    const files = (await fs.promises.readdir(INPUT_DIR)).filter((f) =>
      /\.(jpe?g|png|tiff?|webp)$/i.test(f),
    );
    const out = [];
    for (const fn of files) {
      const base = path.parse(fn).name; // original base name (may have spaces)
      const id = base.replace(/\W+/g, '_'); // underscore-normalized
      const candidates = [
        path.join(OUT_DIR, `${base}.json`),
        path.join(OUT_DIR, `${id}.json`),
        path.join(OUT_DIR, `${base.toLowerCase()}.json`),
        path.join(OUT_DIR, `${id.toLowerCase()}.json`),
      ];
      let jsonPath = null;
      let jsonPathWeb = null;
      for (const p of candidates) {
        try {
          await fs.promises.access(p, fs.constants.R_OK);
          jsonPath = p; // absolute server-side path
          // also provide a web-style relative path for portability
          jsonPathWeb = `/output/${path.basename(p)}`;
          break;
        } catch (_err) {
          // continue
        }
      }
      out.push({
        id,
        thumb: `/imgs/${fn}`,
        full: `/imgs/${fn}`,
        base, // original base filename without extension (may include spaces)
        jsonPath: jsonPathWeb || null, // web relative when known
        hasManifest: !!jsonPath,
      });
    }
    res.json(out);
  } catch (_e) {
    res.status(500).json({ error: _e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   /global/load – load and merge multiple manifests into memory
   Body: { sources: ["/output/foo.json", ...] }
   ═════════════════════════════════════════════════════════ */
app.post('/global/load', express.json(), async (req, res) => {
  try {
    const sources = Array.isArray(req.body?.sources) ? req.body.sources : [];
    if (!sources.length)
      return res.status(400).json({ error: 'sources[] required' });

    const reg = new GlobalRegistry();
    for (let p of sources) {
      if (typeof p !== 'string') continue;
      if (p.startsWith('/output/'))
        p = path.join(OUT_DIR, p.replace(/^\/output\//, ''));
      p = p.replace(/\\/g, '/');
      const resolved = path.resolve(p);
      const outResolved = path.resolve(OUT_DIR);
      if (
        !resolved.startsWith(outResolved + path.sep) &&
        resolved !== outResolved
      ) {
        return res
          .status(400)
          .json({ error: `jsonPath must be within /output: ${p}` });
      }
      await reg.loadSource(resolved);
    }
    try {
      reg.metadataIndex.ensureImageScoping?.();
    } catch {
      // intentionally ignore errors from ensureImageScoping
    }
    globalState.registry = reg;
    rebuildGlobalUriMaps();

    const tagCounts = new Map();
    reg.regionManager.regions.forEach((r) => {
      (r.tags || []).forEach((t) =>
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1),
      );
    });
    res.json({
      ok: true,
      sourcesLoaded: reg.sources.length,
      regionCount: reg.regionManager.regions.length,
      tags: Array.from(tagCounts.entries()).map(([tag, count]) => ({
        tag,
        count,
      })),
    });
  } catch (_e) {
    res.status(500).json({ error: _e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /global/sparql – run query against global registry store
   ═════════════════════════════════════════════════════════ */
app.post('/global/sparql', async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex?.store)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const sparql = req.body.toString();
    const bindings = await qe
      .queryBindings(sparql, {
        sources: [globalState.registry.metadataIndex.store],
      })
      .then((s) => s.toArray());
    const rows = bindings.map((b) =>
      Object.fromEntries(
        [...b].map(([k, v]) => [
          k.value.startsWith('?') ? k.value.slice(1) : k.value,
          v.value,
        ]),
      ),
    );
    res.json(rows);
  } catch (_e) {
    res.status(400).json({ error: _e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /global/regions – resolve a list of URIs to region objects
   Body: { uris: [ ... ] }
   ═════════════════════════════════════════════════════════ */
app.post('/global/regions', express.json(), async (req, res) => {
  try {
    if (!globalState.registry?.regionManager?.regions)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const uris = Array.isArray(req.body?.uris) ? req.body.uris : [];
    if (!uris.length) return res.json({ regions: [] });
    const byUri = new Map();
    globalState.registry.regionManager.regions.forEach((r) => {
      if (r?.metadata?.uri) byUri.set(r.metadata.uri, r);
    });
    // Consider mergedFrom equivalence
    const MERGED_FROM = 'http://example.org/mergedFrom';
    const store = globalState.registry.metadataIndex?.store;
    const alias = new Map(); // src -> target
    try {
      store
        ?.getQuads(null, null, null, null)
        .filter((q) => q.predicate.value === MERGED_FROM)
        .forEach((q) => alias.set(q.object.value, q.subject.value));
    } catch {
      // intentionally ignore errors from ensureImageScoping
    }
    const out = [];
    for (const u of uris) {
      const tgt = byUri.get(u) || byUri.get(alias.get(u));
      if (tgt) out.push(tgt);
    }
    res.json({ regions: out });
  } catch (_e) {
    res.status(500).json({ error: _e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /global/cluster – connect URIs via sameObjectAs and optionally
   propagate their relationships within the cluster. Body:
   { uris:[], propagate:true }
   ═════════════════════════════════════════════════════════ */
// Helper: deterministic cluster IRI for a set of URIs
function clusterIriForUris(uris) {
  try {
    const sorted = Array.from(new Set((uris || []).filter(Boolean))).sort();
    const h = require('crypto')
      .createHash('sha1')
      .update(sorted.join('|'))
      .digest('hex');
    return `urn:cluster:${h}`;
  } catch (_e) {
    return `urn:cluster:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }
}

app.post('/global/cluster', express.json(), async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const uris = Array.isArray(req.body?.uris)
      ? req.body.uris.filter(Boolean)
      : [];
    const propagate = !!req.body?.propagate;
    const sharePreds = Array.isArray(req.body?.sharePreds)
      ? req.body.sharePreds
          .map((k) => String(k))
          .filter(
            (k) => k === 'near' || k === 'contains' || k === 'sameObjectAs',
          )
      : null;
    const linkSame = !!req.body?.linkSame;
    const clusterName =
      typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (uris.length < 2)
      return res.status(400).json({ error: 'provide >=2 uris' });
    const store = globalState.registry.metadataIndex.store;
    const MD = 'http://example.org/metadata#';
    const RDFT = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const CLTYPE = `${MD}Cluster`;
    const INCL = `${MD}inCluster`;
    const clusterIRI = clusterIriForUris(uris);

    store.addQuad(namedNode(clusterIRI), namedNode(RDFT), namedNode(CLTYPE));
    if (clusterName) {
      const RDFS = 'http://www.w3.org/2000/01/rdf-schema#label';
      // Clear previous labels before setting
      try {
        store.removeMatches?.(
          namedNode(clusterIRI),
          namedNode(RDFS),
          null,
          null,
        );
      } catch {
        /* intentionally ignore errors from removeMatches */
      }
      store.addQuad(
        namedNode(clusterIRI),
        namedNode(RDFS),
        literal(clusterName),
      );
      store.addQuad(
        namedNode(clusterIRI),
        namedNode(`${MD}clusterName`),
        literal(clusterName),
      );
      store.addQuad(
        namedNode(clusterIRI),
        namedNode(`${MD}updatedAt`),
        literal(new Date().toISOString()),
      );
    }
    for (const u of uris)
      store.addQuad(namedNode(u), namedNode(INCL), namedNode(clusterIRI));
    if (linkSame) {
      const center = uris[0];
      for (let i = 1; i < uris.length; i++) {
        const u = uris[i];
        store.addQuad(
          namedNode(center),
          namedNode(REL.sameObjectAs),
          namedNode(u),
        );
        store.addQuad(
          namedNode(u),
          namedNode(REL.sameObjectAs),
          namedNode(center),
        );
      }
    }
    // Persist into contributing sources
    for (const src of globalState.registry.sources || []) {
      const sStore = src?.metadataIndex?.store;
      if (!sStore) continue;
      // If any endpoint of the new edges is present in this source, replicate
      const hasAny = uris.some(
        (u) => sStore.getQuads(namedNode(u), null, null, null).length > 0,
      );
      if (hasAny) {
        sStore.addQuad(
          namedNode(clusterIRI),
          namedNode(RDFT),
          namedNode(CLTYPE),
        );
        if (clusterName) {
          const RDFS = 'http://www.w3.org/2000/01/rdf-schema#label';
          try {
            sStore.removeMatches?.(
              namedNode(clusterIRI),
              namedNode(RDFS),
              null,
              null,
            );
          } catch {
            // intentionally ignore errors from removeMatches
          }
          sStore.addQuad(
            namedNode(clusterIRI),
            namedNode(RDFS),
            literal(clusterName),
          );
          sStore.addQuad(
            namedNode(clusterIRI),
            namedNode(`${MD}clusterName`),
            literal(clusterName),
          );
          sStore.addQuad(
            namedNode(clusterIRI),
            namedNode(`${MD}updatedAt`),
            literal(new Date().toISOString()),
          );
        }
        for (const u of uris)
          sStore.addQuad(namedNode(u), namedNode(INCL), namedNode(clusterIRI));
        if (linkSame) {
          const center = uris[0];
          for (let i = 1; i < uris.length; i++) {
            const u = uris[i];
            sStore.addQuad(
              namedNode(center),
              namedNode(REL.sameObjectAs),
              namedNode(u),
            );
            sStore.addQuad(
              namedNode(u),
              namedNode(REL.sameObjectAs),
              namedNode(center),
            );
          }
        }
      }
      try {
        if (Array.isArray(src.tiles) && src.tiles.length)
          await TiledMLSerializer.save(
            src.tiles,
            src.metadataIndex,
            src.regionManager,
            src.path,
          );
        else
          await new Serializer(
            src.pixelMatrix,
            src.metadataIndex,
            src.regionManager,
          ).save(src.path);
      } catch (err) {
        logger.warn(
          'global/cluster save failed for',
          src.path,
          err?.message || err,
        );
      }
    }

    if (propagate) await propagateClusterRelationships(uris, sharePreds);

    // Notify clients to refresh relationship panels for affected URIs
    try {
      io.emit('relationshipsUpdated', { subject: clusterIRI });
      for (const u of uris) io.emit('relationshipsUpdated', { subject: u });
      io.emit('clustersChanged');
    } catch (_) {
      /* optional */
    }

    res.json({ ok: true, cluster: clusterIRI, name: clusterName || null });
  } catch (_e) {
    res.status(500).json({ error: _e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /global/uncluster – remove sameObjectAs edges between URIs
   Body: { uris: [] }
   ═════════════════════════════════════════════════════════ */
app.post('/global/uncluster', express.json(), async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const uris = Array.isArray(req.body?.uris)
      ? req.body.uris.filter(Boolean)
      : [];
    if (uris.length < 2)
      return res.status(400).json({ error: 'provide >=2 uris' });
    const store = globalState.registry.metadataIndex.store;
    const sharePreds = Array.isArray(req.body?.sharePreds)
      ? req.body.sharePreds
          .map((k) => String(k))
          .filter(
            (k) => k === 'near' || k === 'contains' || k === 'sameObjectAs',
          )
      : null;
    const MD = 'http://example.org/metadata#';
    const INCL = namedNode(`${MD}inCluster`);
    const DINCL = namedNode(`${MD}deletedInCluster`);
    // Soft-delete membership: move md:inCluster -> md:deletedInCluster and mark cluster as deprecated
    for (const u of uris) {
      const s = namedNode(u);
      const mems = store.getQuads(s, INCL, null, null);
      mems.forEach((q) => {
        store.removeQuad(q);
        store.addQuad(s, DINCL, q.object);
        try {
          store.addQuad(
            q.object,
            namedNode('http://www.w3.org/2002/07/owl#deprecated'),
            literal(
              'true',
              namedNode('http://www.w3.org/2001/XMLSchema#boolean'),
            ),
          );
        } catch {
          // intentionally ignore errors from removeMatches
        }
      });
    }
    // Soft-delete sameObjectAs links
    for (let i = 0; i < uris.length; i++) {
      for (let j = i + 1; j < uris.length; j++) {
        const a = namedNode(uris[i]);
        const b = namedNode(uris[j]);
        store.removeQuad(a, namedNode(REL.sameObjectAs), b);
        store.removeQuad(b, namedNode(REL.sameObjectAs), a);
        store.addQuad(a, namedNode(DELREL.sameObjectAs), b);
        store.addQuad(b, namedNode(DELREL.sameObjectAs), a);
      }
    }
    // Also remove propagated edges that were created by sharing (filtered by sharePreds)
    const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const keyToRel = {
      near: REL.near,
      contains: REL.contains,
      sameObjectAs: REL.sameObjectAs,
    };
    const PSET = new Set(
      Array.isArray(sharePreds) && sharePreds.length
        ? sharePreds.map((k) => keyToRel[k]).filter(Boolean)
        : [REL.near, REL.contains],
    );
    const URIS = new Set(uris);

    function removePropagated(store) {
      // Find stmt nodes tagged as propagatedFrom, get their subject/predicate/object
      const tag = namedNode(MD + 'propagatedFrom');
      const stmts = store.getQuads(null, tag, null, null).map((q) => q.subject);
      for (const s of stmts) {
        const subj = store.getQuads(
          s,
          namedNode(RDF + 'subject'),
          null,
          null,
        )[0]?.object?.value;
        const pred = store.getQuads(
          s,
          namedNode(RDF + 'predicate'),
          null,
          null,
        )[0]?.object?.value;
        const obj = store.getQuads(s, namedNode(RDF + 'object'), null, null)[0]
          ?.object?.value;
        if (!subj || !pred || !obj) continue;
        if (!PSET.has(pred)) continue;
        // Only remove if either endpoint is in the uncluster set
        if (!(URIS.has(subj) || URIS.has(obj))) continue;
        // Remove base triple and all reification about this stmt
        store.removeQuad(namedNode(subj), namedNode(pred), namedNode(obj));
        const all = store.getQuads(s, null, null, null);
        all.forEach((q) => store.removeQuad(q));
      }
    }

    removePropagated(store);

    // Persist to sources
    for (const src of globalState.registry.sources || []) {
      const sStore = src?.metadataIndex?.store;
      if (!sStore) continue;
      // Mirror membership soft-delete and sameObjectAs deletion
      for (const u of uris) {
        const s = namedNode(u);
        const mems = sStore.getQuads(s, INCL, null, null);
        mems.forEach((q) => {
          sStore.removeQuad(q);
          sStore.addQuad(s, DINCL, q.object);
          try {
            sStore.addQuad(
              q.object,
              namedNode('http://www.w3.org/2002/07/owl#deprecated'),
              literal(
                'true',
                namedNode('http://www.w3.org/2001/XMLSchema#boolean'),
              ),
            );
          } catch {
            // intentionally ignore errors from removeMatches
          }
        });
      }
      for (let i = 0; i < uris.length; i++) {
        for (let j = i + 1; j < uris.length; j++) {
          const a = namedNode(uris[i]);
          const b = namedNode(uris[j]);
          sStore.removeQuad(a, namedNode(REL.sameObjectAs), b);
          sStore.removeQuad(b, namedNode(REL.sameObjectAs), a);
          sStore.addQuad(a, namedNode(DELREL.sameObjectAs), b);
          sStore.addQuad(b, namedNode(DELREL.sameObjectAs), a);
        }
      }
      removePropagated(sStore);

      try {
        if (Array.isArray(src.tiles) && src.tiles.length)
          await TiledMLSerializer.save(
            src.tiles,
            src.metadataIndex,
            src.regionManager,
            src.path,
          );
        else
          await new Serializer(
            src.pixelMatrix,
            src.metadataIndex,
            src.regionManager,
          ).save(src.path);
      } catch (err) {
        logger.warn(
          'global/uncluster save failed for',
          src.path,
          err?.message || err,
        );
      }
    }
    // Notify for each directly affected URI
    try {
      for (const u of uris) io.emit('relationshipsUpdated', { subject: u });
      io.emit('clustersChanged');
    } catch (_) {
      /* optional */
    }
    res.json({ ok: true });
  } catch (_e) {
    res.status(500).json({ error: _e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /global/clusters – compute cluster groups (sameObjectAs) for a set
   of URIs. Body: { uris:[] } → { groups:[{ id, uris:[] }] }
   ═════════════════════════════════════════════════════════ */
app.post('/global/clusters', express.json(), async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const uris = Array.isArray(req.body?.uris)
      ? req.body.uris.filter(Boolean)
      : [];
    const groups = computeClustersForUris(
      globalState.registry.metadataIndex.store,
      uris,
    );
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   GET /global/cluster/list – list clusters with members and metadata
   Query: includeDeleted=0|1
   ═════════════════════════════════════════════════════════ */
app.get('/global/cluster/list', async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const includeDeleted = String(req.query.includeDeleted || '0') === '1';
    const store = globalState.registry.metadataIndex.store;
    const MD = 'http://example.org/metadata#';
    const RDFT = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
    const CLTYPE = `${MD}Cluster`;
    const INCL = `${MD}inCluster`;
    const DINCL = `${MD}deletedInCluster`;
    const OWLDEP = 'http://www.w3.org/2002/07/owl#deprecated';
    const clusters = store
      .getQuads(null, namedNode(RDFT), namedNode(CLTYPE), null)
      .map((q) => q.subject.value);
    const out = [];
    for (const c of clusters) {
      const cNN = namedNode(c);
      const name =
        store.getQuads(cNN, namedNode(`${MD}clusterName`), null, null)[0]
          ?.object?.value ||
        store.getQuads(cNN, namedNode(`${RDFS}label`), null, null)[0]?.object
          ?.value ||
        '';
      const description =
        store.getQuads(cNN, namedNode(`${MD}clusterDescription`), null, null)[0]
          ?.object?.value || '';
      const members = store
        .getQuads(null, namedNode(INCL), cNN, null)
        .map((q) => q.subject.value);
      const deletedMembers = includeDeleted
        ? store
            .getQuads(null, namedNode(DINCL), cNN, null)
            .map((q) => q.subject.value)
        : [];
      const deprecated =
        store.getQuads(cNN, namedNode(OWLDEP), null, null)[0]?.object?.value ===
        'true';
      const deleted =
        deprecated || (members.length === 0 && deletedMembers.length > 0);
      if (!includeDeleted && deleted) continue;
      out.push({ iri: c, name, description, members, deleted });
    }
    res.json({ clusters: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /global/cluster/meta – set name/description for a cluster
   Body: { cluster, name?, description? }
   ═════════════════════════════════════════════════════════ */
app.post('/global/cluster/meta', express.json(), async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const cluster = String(req.body?.cluster || '');
    if (!cluster) return res.status(400).json({ error: 'cluster required' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description =
      typeof req.body?.description === 'string'
        ? req.body.description.trim()
        : '';
    const store = globalState.registry.metadataIndex.store;
    const MD = 'http://example.org/metadata#';
    const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
    const cNN = namedNode(cluster);
    const ts = new Date().toISOString();
    // History and set
    const prevNames = store.getQuads(
      cNN,
      namedNode(`${MD}clusterName`),
      null,
      null,
    );
    for (const q of prevNames) {
      if (name && q.object?.value && q.object.value !== name)
        store.addQuad(
          cNN,
          namedNode(`${MD}clusterNameHistory`),
          literal(`${ts}::${q.object.value}`),
        );
    }
    if (typeof store.removeMatches === 'function') {
      store.removeMatches(cNN, namedNode(`${MD}clusterName`), null, null);
      store.removeMatches(cNN, namedNode(`${RDFS}label`), null, null);
    } else {
      store
        .getQuads(cNN, namedNode(`${MD}clusterName`), null, null)
        .forEach((q) => store.removeQuad(q));
      store
        .getQuads(cNN, namedNode(`${RDFS}label`), null, null)
        .forEach((q) => store.removeQuad(q));
    }
    if (name) {
      store.addQuad(cNN, namedNode(`${RDFS}label`), literal(name));
      store.addQuad(cNN, namedNode(`${MD}clusterName`), literal(name));
    }
    if (description) {
      const prev = store.getQuads(
        cNN,
        namedNode(`${MD}clusterDescription`),
        null,
        null,
      );
      for (const q of prev) {
        if (q.object?.value && q.object.value !== description)
          store.addQuad(
            cNN,
            namedNode(`${MD}clusterDescriptionHistory`),
            literal(`${ts}::${q.object.value}`),
          );
      }
      if (typeof store.removeMatches === 'function')
        store.removeMatches(
          cNN,
          namedNode(`${MD}clusterDescription`),
          null,
          null,
        );
      else
        store
          .getQuads(cNN, namedNode(`${MD}clusterDescription`), null, null)
          .forEach((q) => store.removeQuad(q));
      store.addQuad(
        cNN,
        namedNode(`${MD}clusterDescription`),
        literal(description),
      );
    }
    store.addQuad(cNN, namedNode(`${MD}updatedAt`), literal(ts));

    // Persist to sources that contain the cluster or any of its members
    for (const src of globalState.registry.sources || []) {
      const sStore = src?.metadataIndex?.store;
      if (!sStore) continue;
      const hasCluster =
        sStore.getQuads(cNN, null, null, null).length > 0 ||
        sStore.getQuads(null, null, cNN, null).length > 0;
      if (!hasCluster) continue;
      // Mirror changes
      if (typeof sStore.removeMatches === 'function') {
        sStore.removeMatches(cNN, namedNode(`${MD}clusterName`), null, null);
        sStore.removeMatches(cNN, namedNode(`${RDFS}label`), null, null);
        sStore.removeMatches(
          cNN,
          namedNode(`${MD}clusterDescription`),
          null,
          null,
        );
      }
      if (name) {
        sStore.addQuad(cNN, namedNode(`${RDFS}label`), literal(name));
        sStore.addQuad(cNN, namedNode(`${MD}clusterName`), literal(name));
      }
      if (description)
        sStore.addQuad(
          cNN,
          namedNode(`${MD}clusterDescription`),
          literal(description),
        );
      sStore.addQuad(cNN, namedNode(`${MD}updatedAt`), literal(ts));
      try {
        if (Array.isArray(src.tiles) && src.tiles.length)
          await TiledMLSerializer.save(
            src.tiles,
            src.metadataIndex,
            src.regionManager,
            src.path,
          );
        else
          await new Serializer(
            src.pixelMatrix,
            src.metadataIndex,
            src.regionManager,
          ).save(src.path);
      } catch (err) {
        logger.warn(
          'cluster/meta save failed for',
          src.path,
          err?.message || err,
        );
      }
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /global/cluster/link – link two clusters, optionally named
   Body: { a, b, predicate?, name?, description?, enabled? }
   ═════════════════════════════════════════════════════════ */
app.post('/global/cluster/link', express.json(), async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const a = String(req.body?.a || '');
    const b = String(req.body?.b || '');
    if (!a || !b) return res.status(400).json({ error: 'a, b required' });
    const predicateKey = String(req.body?.predicate || 'clusterLinkedTo');
    const propagate = !!req.body?.propagate;
    const sharePreds = Array.isArray(req.body?.sharePreds)
      ? req.body.sharePreds
          .map((k) => String(k))
          .filter(
            (k) => k === 'near' || k === 'contains' || k === 'sameObjectAs',
          )
      : null;
    const enabled = req.body?.enabled === undefined ? true : !!req.body.enabled;
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const description =
      typeof req.body?.description === 'string'
        ? req.body.description.trim()
        : '';
    const key =
      toKey(REL[predicateKey] || DELREL[predicateKey]) || predicateKey;
    const baseP = REL[key] || REL.clusterLinkedTo;
    const delP = DELREL[key] || DELREL.clusterLinkedTo;
    const store = globalState.registry.metadataIndex.store;
    const aNN = namedNode(a);
    const bNN = namedNode(b);
    // Toggle add active/deleted
    store.removeQuad(aNN, namedNode(baseP), bNN);
    store.removeQuad(aNN, namedNode(delP), bNN);
    store.addQuad(aNN, namedNode(enabled ? baseP : delP), bNN);
    // Optional meta on reified statement
    if (name || description)
      updateRelMetaWithHistory(
        globalState.registry.metadataIndex,
        a,
        baseP,
        b,
        name,
        description,
      );
    // Persist to sources touching either cluster
    for (const src of globalState.registry.sources || []) {
      const sStore = src?.metadataIndex?.store;
      if (!sStore) continue;
      const touches =
        sStore.getQuads(aNN, null, null, null).length > 0 ||
        sStore.getQuads(null, null, aNN, null).length > 0 ||
        sStore.getQuads(bNN, null, null, null).length > 0 ||
        sStore.getQuads(null, null, bNN, null).length > 0;
      if (!touches) continue;
      sStore.removeQuad(aNN, namedNode(baseP), bNN);
      sStore.removeQuad(aNN, namedNode(delP), bNN);
      sStore.addQuad(aNN, namedNode(enabled ? baseP : delP), bNN);
      if (name || description)
        updateRelMetaWithHistory(
          src.metadataIndex,
          a,
          baseP,
          b,
          name,
          description,
        );
      try {
        if (Array.isArray(src.tiles) && src.tiles.length)
          await TiledMLSerializer.save(
            src.tiles,
            src.metadataIndex,
            src.regionManager,
            src.path,
          );
        else
          await new Serializer(
            src.pixelMatrix,
            src.metadataIndex,
            src.regionManager,
          ).save(src.path);
      } catch (err) {
        logger.warn(
          'cluster/link save failed for',
          src.path,
          err?.message || err,
        );
      }
    }
    // If requested, propagate relationships across the union of both clusters
    if (propagate) {
      try {
        await propagateAcrossClusters(a, b, sharePreds);
      } catch (_e) {
        logger.warn('propagateAcrossClusters failed', _e?.message || _e);
      }
    }

    // If disabling the link, also soft-delete relationships that were propagated
    // due to this link (tagged md:propagatedFrom "clusterLink").
    if (!enabled) {
      try {
        await softDeletePropagatedForLinkedClusters(a, b, sharePreds);
      } catch (err) {
        logger.warn(
          'softDeletePropagatedForLinkedClusters failed',
          err?.message || err,
        );
      }
    }

    // Broadcast updates for both clusters involved
    try {
      io.emit('relationshipsUpdated', { subject: a });
      io.emit('relationshipsUpdated', { subject: b });
    } catch (_) {
      /* optional */
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Propagate near/contains relationships across the union of two clusters
async function propagateAcrossClusters(clusterA, clusterB, predKeys = null) {
  const registry = globalState.registry;
  if (!registry?.metadataIndex) return;
  const store = registry.metadataIndex.store;
  const MD = 'http://example.org/metadata#';
  const INCL = namedNode(`${MD}inCluster`);
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const keyToRel = {
    near: REL.near,
    contains: REL.contains,
    sameObjectAs: REL.sameObjectAs,
  };
  const preds =
    Array.isArray(predKeys) && predKeys.length
      ? predKeys.map((k) => keyToRel[k]).filter(Boolean)
      : [REL.near, REL.contains, REL.sameObjectAs];

  // Collect active members for both clusters
  const cA = namedNode(clusterA);
  const cB = namedNode(clusterB);
  const membersA = store
    .getQuads(null, INCL, cA, null)
    .map((q) => q.subject.value);
  const membersB = store
    .getQuads(null, INCL, cB, null)
    .map((q) => q.subject.value);
  const union = [...new Set([...membersA, ...membersB])];
  if (!union.length) return;

  function addPropagatedEdge(targetStore, subj, pred, obj) {
    targetStore.addQuad(namedNode(subj), namedNode(pred), namedNode(obj));
    try {
      const stmtIri = OntologyExt.stmtIRI(subj, pred, obj);
      const sNN = namedNode(stmtIri);
      targetStore.addQuad(
        sNN,
        namedNode(RDF + 'type'),
        namedNode(RDF + 'Statement'),
      );
      targetStore.addQuad(sNN, namedNode(RDF + 'subject'), namedNode(subj));
      targetStore.addQuad(sNN, namedNode(RDF + 'predicate'), namedNode(pred));
      targetStore.addQuad(sNN, namedNode(RDF + 'object'), namedNode(obj));
      targetStore.addQuad(
        sNN,
        namedNode(MD + 'propagatedFrom'),
        literal('clusterLink'),
      );
    } catch (_) {
      // intentionally ignore errors from ensureImageScoping
    }
  }

  // Collect edges attached to any member in the union
  const outEdges = [];
  const inEdges = [];
  for (const s of union) {
    const sNN = namedNode(s);
    for (const p of preds) {
      store
        .getQuads(sNN, namedNode(p), null, null)
        .forEach((q) => outEdges.push([s, p, q.object.value]));
      store
        .getQuads(null, namedNode(p), sNN, null)
        .forEach((q) => inEdges.push([q.subject.value, p, s]));
    }
  }
  // Propagate across the union set
  for (const [s, p, o] of outEdges) {
    for (const s2 of union) {
      if (s2 === s) continue;
      const exists =
        store.getQuads(namedNode(s2), namedNode(p), namedNode(o), null).length >
        0;
      if (!exists) addPropagatedEdge(store, s2, p, o);
    }
  }
  for (const [x, p, s] of inEdges) {
    for (const s2 of union) {
      if (s2 === s) continue;
      const exists =
        store.getQuads(namedNode(x), namedNode(p), namedNode(s2), null).length >
        0;
      if (!exists) addPropagatedEdge(store, x, p, s2);
    }
  }

  // Persist to sources that contain any endpoints
  for (const src of registry.sources || []) {
    const sStore = src?.metadataIndex?.store;
    if (!sStore) continue;
    const touches = (u) =>
      sStore.getQuads(namedNode(u), null, null, null).length > 0 ||
      sStore.getQuads(null, null, namedNode(u), null).length > 0;
    for (const [s, p, o] of [
      ...outEdges,
      ...inEdges.map(([x, p, s]) => [x, p, s]),
    ]) {
      for (const s2 of union) {
        if (s2 === s) continue;
        if (!(touches(s2) || touches(s) || touches(o))) continue;
        if (
          sStore.getQuads(namedNode(s2), namedNode(p), namedNode(o), null)
            .length === 0
        ) {
          addPropagatedEdge(sStore, s2, p, o);
        }
      }
    }
    try {
      if (Array.isArray(src.tiles) && src.tiles.length)
        await TiledMLSerializer.save(
          src.tiles,
          src.metadataIndex,
          src.regionManager,
          src.path,
        );
      else
        await new Serializer(
          src.pixelMatrix,
          src.metadataIndex,
          src.regionManager,
        ).save(src.path);
    } catch (e) {
      logger.warn('propagateAcrossClusters save failed for', src.path, e);
    }
  }

  // Notify UI for union members since their effective relations changed
  try {
    union.forEach((u) => io.emit('relationshipsUpdated', { subject: u }));
  } catch (_) {
    /* optional */
  }
}

/* ═══════════════════════════════════════════════════════════
   POST /global/cluster/delete – soft-delete a cluster resource
   Body: { cluster }
   Moves md:inCluster → md:deletedInCluster for all members and marks
   the cluster node owl:deprecated true. Also soft-deletes cluster links.
   ═════════════════════════════════════════════════════════ */
app.post('/global/cluster/delete', express.json(), async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const cluster = String(req.body?.cluster || '');
    if (!cluster) return res.status(400).json({ error: 'cluster required' });
    const sharePreds = Array.isArray(req.body?.sharePreds)
      ? req.body.sharePreds
          .map((k) => String(k))
          .filter(
            (k) => k === 'near' || k === 'contains' || k === 'sameObjectAs',
          )
      : null;
    const store = globalState.registry.metadataIndex.store;
    const MD = 'http://example.org/metadata#';
    const INCL = namedNode(`${MD}inCluster`);
    const DINCL = namedNode(`${MD}deletedInCluster`);
    const OWLDEP = namedNode('http://www.w3.org/2002/07/owl#deprecated');

    const cNN = namedNode(cluster);

    // First, soft-delete any relationships propagated due to links or cluster sharing
    // while members are still marked as md:inCluster so I can detect them.
    try {
      const membs = store
        .getQuads(null, INCL, cNN, null)
        .map((q) => q.subject.value);
      if (membs.length) {
        await softDeletePropagatedForLinkedClusters(
          cluster,
          cluster,
          sharePreds,
        );
        await softDeletePropagatedForCluster(cluster, sharePreds);
      }
    } catch (e) {
      logger.warn(
        'cluster/delete soft-delete of propagated link/cluster relations failed',
        e?.message || e,
      );
    }

    // Move all membership edges for this cluster to deletedInCluster
    const mems = store.getQuads(null, INCL, cNN, null);
    for (const q of mems) {
      store.removeQuad(q);
      store.addQuad(q.subject, DINCL, cNN);
    }
    // Mark cluster deprecated
    store.addQuad(
      cNN,
      OWLDEP,
      literal('true', namedNode('http://www.w3.org/2001/XMLSchema#boolean')),
    );

    // Soft-delete cluster links (clusterLinkedTo/sameObjectAs) where cluster is endpoint
    const pairs = [
      [REL.clusterLinkedTo, DELREL.clusterLinkedTo],
      [REL.sameObjectAs, DELREL.sameObjectAs],
    ];
    for (const [p, dp] of pairs) {
      const pNN = namedNode(p);
      const dpNN = namedNode(dp);
      // outgoing
      store.getQuads(cNN, pNN, null, null).forEach((q) => {
        store.removeQuad(q);
        store.addQuad(cNN, dpNN, q.object);
      });
      // incoming
      store.getQuads(null, pNN, cNN, null).forEach((q) => {
        store.removeQuad(q);
        store.addQuad(q.subject, dpNN, cNN);
      });
    }

    // Also soft-delete any relationships propagated due to cluster links that touch this cluster's members
    try {
      const membs = store
        .getQuads(null, INCL, cNN, null)
        .map((q) => q.subject.value);
      if (membs.length) {
        // Use the helper with same cluster for A/B; it will operate on members
        await softDeletePropagatedForLinkedClusters(
          cluster,
          cluster,
          sharePreds,
        );
        // Also soft-delete relationships propagated via cluster sharing (tagged "cluster")
        await softDeletePropagatedForCluster(cluster, sharePreds);
      }
    } catch (e) {
      logger.warn(
        'cluster/delete soft-delete of propagated link relations failed',
        e?.message || e,
      );
    }

    // Persist to sources that reference this cluster or its members
    for (const src of globalState.registry.sources || []) {
      const sStore = src?.metadataIndex?.store;
      if (!sStore) continue;
      const touches =
        sStore.getQuads(cNN, null, null, null).length > 0 ||
        sStore.getQuads(null, null, cNN, null).length > 0;
      if (!touches) continue;
      const mems2 = sStore.getQuads(null, INCL, cNN, null);
      for (const q of mems2) {
        sStore.removeQuad(q);
        sStore.addQuad(q.subject, DINCL, cNN);
      }
      sStore.addQuad(
        cNN,
        OWLDEP,
        literal('true', namedNode('http://www.w3.org/2001/XMLSchema#boolean')),
      );
      for (const [p, dp] of pairs) {
        const pNN = namedNode(p);
        const dpNN = namedNode(dp);
        sStore.getQuads(cNN, pNN, null, null).forEach((q) => {
          sStore.removeQuad(q);
          sStore.addQuad(cNN, dpNN, q.object);
        });
        sStore.getQuads(null, pNN, cNN, null).forEach((q) => {
          sStore.removeQuad(q);
          sStore.addQuad(q.subject, dpNN, cNN);
        });
      }
      try {
        if (Array.isArray(src.tiles) && src.tiles.length)
          await TiledMLSerializer.save(
            src.tiles,
            src.metadataIndex,
            src.regionManager,
            src.path,
          );
        else
          await new Serializer(
            src.pixelMatrix,
            src.metadataIndex,
            src.regionManager,
          ).save(src.path);
      } catch (e) {
        logger.warn(
          'cluster/delete save failed for',
          src.path,
          e?.message || e,
        );
      }
    }

    // Notify clients: the cluster and its members changed state
    try {
      io.emit('relationshipsUpdated', { subject: cluster });
      const memsNow = store
        .getQuads(null, DINCL, cNN, null)
        .map((q) => q.subject.value);
      for (const u of memsNow) io.emit('relationshipsUpdated', { subject: u });
      io.emit('clustersChanged');
    } catch (_) {
      /* optional */
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function neighborsSame(store, u) {
  const s = namedNode(u);
  const out = new Set();
  store
    .getQuads(s, namedNode(REL.sameObjectAs), null, null)
    .forEach((q) => out.add(q.object.value));
  store
    .getQuads(null, namedNode(REL.sameObjectAs), s, null)
    .forEach((q) => out.add(q.subject.value));
  return [...out];
}

function neighborsCluster(store, u) {
  const MD = 'http://example.org/metadata#';
  const INCL = namedNode(`${MD}inCluster`);
  const s = namedNode(u);
  const out = new Set();
  const clusters = store.getQuads(s, INCL, null, null).map((q) => q.object);
  for (const c of clusters) {
    store
      .getQuads(null, INCL, c, null)
      .forEach((q) => out.add(q.subject.value));
  }
  out.delete(u);
  return [...out];
}

function bfsCluster(store, seeds) {
  const seen = new Set();
  const q = [...seeds];
  while (q.length) {
    const u = q.shift();
    if (!u || seen.has(u)) continue;
    seen.add(u);
    const neigh = new Set([
      ...neighborsSame(store, u),
      ...neighborsCluster(store, u),
    ]);
    neigh.forEach((v) => {
      if (!seen.has(v)) q.push(v);
    });
  }
  return [...seen];
}

function computeClustersForUris(store, uris) {
  const remaining = new Set(uris);
  const groups = [];
  while (remaining.size) {
    const start = remaining.values().next().value;
    const cluster = bfsCluster(store, [start]);
    cluster.forEach((u) => remaining.delete(u));
    const id = cluster.slice().sort()[0] || start;
    groups.push({ id, uris: cluster });
  }
  return groups;
}

// Soft-delete any relationships (near/contains/sameObjectAs by default or filtered
// via predKeys) that were propagated from a cluster link (md:propagatedFrom "clusterLink")
// and involve any member from the union of the two clusters.
async function softDeletePropagatedForLinkedClusters(
  clusterA,
  clusterB,
  predKeys = null,
) {
  const registry = globalState.registry;
  if (!registry?.metadataIndex) return;
  const store = registry.metadataIndex.store;
  const MD = 'http://example.org/metadata#';
  const INCL = namedNode(`${MD}inCluster`);
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

  const keyToRel = {
    near: REL.near,
    contains: REL.contains,
    sameObjectAs: REL.sameObjectAs,
  };
  const allowed = new Set(
    Array.isArray(predKeys) && predKeys.length
      ? predKeys.map((k) => keyToRel[k]).filter(Boolean)
      : [REL.near, REL.contains, REL.sameObjectAs],
  );

  // Collect union of active members for both clusters
  const cA = namedNode(clusterA);
  const cB = namedNode(clusterB);
  const members = new Set([
    ...store.getQuads(null, INCL, cA, null).map((q) => q.subject.value),
    ...store.getQuads(null, INCL, cB, null).map((q) => q.subject.value),
  ]);
  if (!members.size) return;

  function baseToDeleted(pred) {
    const key = toKey(pred);
    return key && DELREL[key] ? DELREL[key] : null;
  }

  function softDeleteInStore(targetStore) {
    const tag = namedNode(MD + 'propagatedFrom');
    const fromLink = literal('clusterLink');
    const stmts = targetStore
      .getQuads(null, tag, fromLink, null)
      .map((q) => q.subject);
    for (const s of stmts) {
      const subj = targetStore.getQuads(
        s,
        namedNode(RDF + 'subject'),
        null,
        null,
      )[0]?.object?.value;
      const pred = targetStore.getQuads(
        s,
        namedNode(RDF + 'predicate'),
        null,
        null,
      )[0]?.object?.value;
      const obj = targetStore.getQuads(
        s,
        namedNode(RDF + 'object'),
        null,
        null,
      )[0]?.object?.value;
      if (!subj || !pred || !obj) continue;
      if (!allowed.has(pred)) continue;
      if (!(members.has(subj) || members.has(obj))) continue; // only those touching union
      // Statement is tagged propagatedFrom=clusterLink in this store → delete here (inherited copy).
      const delPred = baseToDeleted(pred);
      if (!delPred) continue;
      // Move active triple to deleted variant (soft delete). Keep reification metadata.
      try {
        targetStore.removeQuad(
          namedNode(subj),
          namedNode(pred),
          namedNode(obj),
        );
      } catch (_e) {
        /* ignore */
      }
      const already =
        targetStore.getQuads(
          namedNode(subj),
          namedNode(delPred),
          namedNode(obj),
          null,
        ).length > 0;
      if (!already)
        targetStore.addQuad(
          namedNode(subj),
          namedNode(delPred),
          namedNode(obj),
        );
      // Fire UI updates for endpoints of this deleted relation
      try {
        io.emit('relationshipsUpdated', { subject: subj });
        io.emit('relationshipsUpdated', { subject: obj });
      } catch (_) {
        /* optional */
      }
    }
  }

  // Apply to registry store
  softDeleteInStore(store);
  // Mirror to contributing sources and persist
  for (const src of registry.sources || []) {
    const sStore = src?.metadataIndex?.store;
    if (!sStore) continue;
    softDeleteInStore(sStore);
    try {
      if (Array.isArray(src.tiles) && src.tiles.length)
        await TiledMLSerializer.save(
          src.tiles,
          src.metadataIndex,
          src.regionManager,
          src.path,
        );
      else
        await new Serializer(
          src.pixelMatrix,
          src.metadataIndex,
          src.regionManager,
        ).save(src.path);
    } catch (e) {
      logger.warn(
        'soft-delete propagated (clusterLink) save failed for',
        src.path,
        e?.message || e,
      );
    }
  }
}

// Soft-delete relationships propagated from a single cluster (tagged propagatedFrom "cluster")
// touching any active member of that cluster. Filter by predKeys when provided.
async function softDeletePropagatedForCluster(cluster, predKeys = null) {
  const registry = globalState.registry;
  if (!registry?.metadataIndex) return;
  const store = registry.metadataIndex.store;
  const MD = 'http://example.org/metadata#';
  const INCL = namedNode(`${MD}inCluster`);
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

  const keyToRel = {
    near: REL.near,
    contains: REL.contains,
    sameObjectAs: REL.sameObjectAs,
  };
  const allowed = new Set(
    Array.isArray(predKeys) && predKeys.length
      ? predKeys.map((k) => keyToRel[k]).filter(Boolean)
      : [REL.near, REL.contains, REL.sameObjectAs],
  );

  // Active members of this cluster
  const cNN = namedNode(cluster);
  const members = new Set(
    store.getQuads(null, INCL, cNN, null).map((q) => q.subject.value),
  );
  if (!members.size) return;

  function baseToDeleted(pred) {
    const key = toKey(pred);
    return key && DELREL[key] ? DELREL[key] : null;
  }

  function softDeleteInStore(targetStore) {
    const tag = namedNode(MD + 'propagatedFrom');
    const fromCluster = literal('cluster');
    const stmts = targetStore
      .getQuads(null, tag, fromCluster, null)
      .map((q) => q.subject);
    for (const s of stmts) {
      const subj = targetStore.getQuads(
        s,
        namedNode(RDF + 'subject'),
        null,
        null,
      )[0]?.object?.value;
      const pred = targetStore.getQuads(
        s,
        namedNode(RDF + 'predicate'),
        null,
        null,
      )[0]?.object?.value;
      const obj = targetStore.getQuads(
        s,
        namedNode(RDF + 'object'),
        null,
        null,
      )[0]?.object?.value;
      if (!subj || !pred || !obj) continue;
      if (!allowed.has(pred)) continue;
      if (!(members.has(subj) || members.has(obj))) continue;
      // This stmt is explicitly tagged as propagated in this store → treat as inherited copy.
      const delPred = baseToDeleted(pred);
      if (!delPred) continue;
      try {
        targetStore.removeQuad(
          namedNode(subj),
          namedNode(pred),
          namedNode(obj),
        );
      } catch (_) {
        /* ignore */
      }
      const already =
        targetStore.getQuads(
          namedNode(subj),
          namedNode(delPred),
          namedNode(obj),
          null,
        ).length > 0;
      if (!already)
        targetStore.addQuad(
          namedNode(subj),
          namedNode(delPred),
          namedNode(obj),
        );
      // Fire UI updates for endpoints
      try {
        io.emit('relationshipsUpdated', { subject: subj });
        io.emit('relationshipsUpdated', { subject: obj });
      } catch (_) {
        /* optional */
      }
    }
  }

  softDeleteInStore(store);
  for (const src of registry.sources || []) {
    const sStore = src?.metadataIndex?.store;
    if (!sStore) continue;
    softDeleteInStore(sStore);
    try {
      if (Array.isArray(src.tiles) && src.tiles.length)
        await TiledMLSerializer.save(
          src.tiles,
          src.metadataIndex,
          src.regionManager,
          src.path,
        );
      else
        await new Serializer(
          src.pixelMatrix,
          src.metadataIndex,
          src.regionManager,
        ).save(src.path);
    } catch (e) {
      logger.warn(
        'soft-delete propagated (cluster) save failed for',
        src.path,
        e?.message || e,
      );
    }
  }
}

async function propagateClusterRelationships(uris, predKeys = null) {
  const registry = globalState.registry;
  if (!registry?.metadataIndex) return;
  const store = registry.metadataIndex.store;
  const cluster = bfsCluster(store, uris);
  if (!cluster.length) return;
  const keyToRel = {
    near: REL.near,
    contains: REL.contains,
    sameObjectAs: REL.sameObjectAs,
  };
  const preds =
    Array.isArray(predKeys) && predKeys.length
      ? predKeys.map((k) => keyToRel[k]).filter(Boolean)
      : [REL.near, REL.contains]; // default
  const MD = 'http://example.org/metadata#';
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

  function addPropagatedEdge(targetStore, subj, pred, obj) {
    // Base triple
    targetStore.addQuad(namedNode(subj), namedNode(pred), namedNode(obj));
    // Reify and tag as propagatedFrom "cluster"
    try {
      const stmtIri = OntologyExt.stmtIRI(subj, pred, obj);
      const sNN = namedNode(stmtIri);
      targetStore.addQuad(
        sNN,
        namedNode(RDF + 'type'),
        namedNode(RDF + 'Statement'),
      );
      targetStore.addQuad(sNN, namedNode(RDF + 'subject'), namedNode(subj));
      targetStore.addQuad(sNN, namedNode(RDF + 'predicate'), namedNode(pred));
      targetStore.addQuad(sNN, namedNode(RDF + 'object'), namedNode(obj));
      targetStore.addQuad(
        sNN,
        namedNode(MD + 'propagatedFrom'),
        literal('cluster'),
      );
    } catch (_) {
      // ignore reification tagging failures
    }
  }

  // Collect outgoing and incoming edges for active relations only
  const outEdges = [];
  const inEdges = [];
  for (const s of cluster) {
    const sNN = namedNode(s);
    for (const p of preds) {
      store
        .getQuads(sNN, namedNode(p), null, null)
        .forEach((q) => outEdges.push([s, p, q.object.value]));
      store
        .getQuads(null, namedNode(p), sNN, null)
        .forEach((q) => inEdges.push([q.subject.value, p, s]));
    }
  }
  // Propagate to all members
  for (const [s, p, o] of outEdges) {
    for (const s2 of cluster) {
      if (s2 === s) continue;
      const exists =
        store.getQuads(namedNode(s2), namedNode(p), namedNode(o), null).length >
        0;
      if (!exists) addPropagatedEdge(store, s2, p, o);
    }
  }
  for (const [x, p, s] of inEdges) {
    for (const s2 of cluster) {
      if (s2 === s) continue;
      const exists =
        store.getQuads(namedNode(x), namedNode(p), namedNode(s2), null).length >
        0;
      if (!exists) addPropagatedEdge(store, x, p, s2);
    }
  }
  // Persist to sources: add any new edges to stores that contain affected endpoints
  for (const src of registry.sources || []) {
    const sStore = src?.metadataIndex?.store;
    if (!sStore) continue;
    const touches = (u) =>
      sStore.getQuads(namedNode(u), null, null, null).length > 0 ||
      sStore.getQuads(null, null, namedNode(u), null).length > 0;
    for (const [s, p, o] of [
      ...outEdges,
      ...inEdges.map(([x, p, s]) => [x, p, s]),
    ]) {
      for (const s2 of cluster) {
        if (s2 === s) continue;
        if (!(touches(s2) || touches(s) || touches(o))) continue;
        if (
          sStore.getQuads(namedNode(s2), namedNode(p), namedNode(o), null)
            .length === 0
        ) {
          addPropagatedEdge(sStore, s2, p, o);
        }
      }
    }
    try {
      if (Array.isArray(src.tiles) && src.tiles.length)
        await TiledMLSerializer.save(
          src.tiles,
          src.metadataIndex,
          src.regionManager,
          src.path,
        );
      else
        await new Serializer(
          src.pixelMatrix,
          src.metadataIndex,
          src.regionManager,
        ).save(src.path);
    } catch (e) {
      logger.warn(
        'propagateClusterRelationships save failed for',
        src.path,
        e?.message || e,
      );
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   GET /global/crop – return a cropped PNG of a region's content
   Query: uri=regionURI&size=240
   ═════════════════════════════════════════════════════════ */
app.get('/global/crop', async (req, res) => {
  try {
    if (!globalState.registry?.regionManager?.regions)
      return res.status(400).send('Global registry not loaded');
    const uri = String(req.query.uri || '');
    if (!uri) return res.status(400).send('uri missing');
    const m = uri.match(/^uri:\/\/([^/\s]+)\//);
    if (!m) return res.status(400).send('invalid uri');
    const imageName = m[1];
    // Find boundary
    const b = globalState.uriToBoundary.get(uri);
    if (!b) return res.status(404).send('boundary not found');
    // Use floor for start and ceil for end to avoid rounding drift issues
    const leftF = Math.floor(b.x1);
    const topF = Math.floor(b.y1);
    const rightC = Math.ceil(b.x2);
    const bottomC = Math.ceil(b.y2);
    let left = Math.max(0, leftF);
    let top = Math.max(0, topF);
    let width = Math.max(1, rightC - leftF);
    let height = Math.max(1, bottomC - topF);
    const wantBlur = String(req.query.blur || '1') !== '0';

    // Try to locate the contributing source first. Prefer
    // in-memory data (pixel matrix or tiles) over reading original files.
    let srcPath = null;
    let contributingSrc = null;
    try {
      const sUri = namedNode(uri);
      contributingSrc = globalState.registry.sources.find(
        (s) =>
          (s?.metadataIndex?.store?.getQuads?.(sUri, null, null, null)
            ?.length || 0) > 0,
      );
    } catch (_) {
      // ignore
    }

    // Single-image: crop from pixel matrix in memory
    if (contributingSrc?.pixelMatrix) {
      const pm = contributingSrc.pixelMatrix;
      if (width < 0) {
        left = left + width;
        width = -width;
      }
      if (height < 0) {
        top = top + height;
        height = -height;
      }
      left = Math.max(0, Math.min(left, Math.max(0, pm.width - 1)));
      top = Math.max(0, Math.min(top, Math.max(0, pm.height - 1)));
      width = Math.max(1, Math.min(width, Math.max(1, pm.width - left)));
      height = Math.max(1, Math.min(height, Math.max(1, pm.height - top)));
      const rawBuf = pm.toBinary();
      let ch = pm.channels;
      const perPx = Math.round(rawBuf.length / (pm.width * pm.height));
      if ((perPx === 3 || perPx === 4) && perPx !== pm.channels) ch = perPx;
      const size = Math.max(
        24,
        Math.min(1024, parseInt(req.query.size || '240', 10) || 240),
      );
      let img = sharp(rawBuf, {
        raw: { width: pm.width, height: pm.height, channels: ch },
      }).extract({ left, top, width, height });

      // Optional blur overlays for regions that fall within this crop
      let comps = [];
      try {
        if (!wantBlur) throw new Error('blur disabled');
        const store = globalState.registry.metadataIndex?.store;
        if (store) {
          const MD = 'http://example.org/metadata#';
          const RDFT = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
          const BLUR = `${MD}PrivacyAction`;
          const ACTION = `${MD}action`;
          const TARGET = `${MD}target`;
          const actions = store
            .getQuads(null, namedNode(RDFT), namedNode(BLUR), null)
            .map((q) => q.subject.value);
          for (const a of actions) {
            const actVal = store.getQuads(
              namedNode(a),
              namedNode(ACTION),
              null,
              null,
            )[0]?.object?.value;
            const tgt = store.getQuads(
              namedNode(a),
              namedNode(TARGET),
              null,
              null,
            )[0]?.object?.value;
            if (actVal !== 'blur' || !tgt) continue;
            const reg = globalState.registry.regionManager.regions.find(
              (r) => r.metadata?.uri === tgt,
            );
            if (!reg) continue;
            const bb = reg.boundary;
            const rx1 = left,
              ry1 = top,
              rx2 = left + width,
              ry2 = top + height;
            const ox1 = Math.max(rx1, Math.floor(bb.x1));
            const oy1 = Math.max(ry1, Math.floor(bb.y1));
            const ox2 = Math.min(rx2, Math.ceil(bb.x2));
            const oy2 = Math.min(ry2, Math.ceil(bb.y2));
            let ow = Math.max(0, ox2 - ox1);
            let oh = Math.max(0, oy2 - oy1);
            if (ow <= 0 || oh <= 0) continue;
            let dx = Math.max(0, ox1 - left);
            let dy = Math.max(0, oy1 - top);
            // Final clamp to ensure patch fits entirely within base crop
            if (dx >= width || dy >= height) continue;
            if (dx + ow > width) ow = Math.max(0, width - dx);
            if (dy + oh > height) oh = Math.max(0, height - dy);
            if (ow <= 0 || oh <= 0) continue;
            const patch = await img
              .clone()
              .extract({ left: dx, top: dy, width: ow, height: oh })
              .blur(15)
              .png()
              .toBuffer();
            comps.push({ input: patch, left: dx, top: dy });
          }
        }
      } catch (_) {
        // optional
      }

      let buf;
      try {
        const base = comps.length ? img.clone().composite(comps) : img;
        buf = await base
          .resize({
            width: size,
            height: size,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
      } catch (_ignore) {
        // Fallback: if intended blur, blur the whole crop; else use original
        const fallback =
          wantBlur && comps.length ? img.clone().blur(15) : img.clone();
        buf = await fallback
          .resize({
            width: size,
            height: size,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
      }
      return res.type('image/png').send(buf);
    }

    // Tiled source: compose from overlapping tiles in memory
    if (Array.isArray(contributingSrc?.tiles) && contributingSrc.tiles.length) {
      // base RGBA canvas
      const size = Math.max(
        24,
        Math.min(1024, parseInt(req.query.size || '240', 10) || 240),
      );
      const overlays = [];
      const dbgOverlays = [];
      const DBG = !!process.env.DEBUG;
      if (DBG) {
        logger.info('[global/crop] tiled compose', {
          uri,
          baseW: width,
          baseH: height,
          left,
          top,
        });
      }
      for (const t of contributingSrc.tiles) {
        const pm = t.pixelMatrix;
        const tileW = pm.width,
          tileH = pm.height;
        const tx1 = t.x,
          ty1 = t.y,
          tx2 = t.x + tileW,
          ty2 = t.y + tileH;
        const rx1 = left,
          ry1 = top,
          rx2 = left + width,
          ry2 = top + height;
        const ox1 = Math.max(rx1, tx1);
        const oy1 = Math.max(ry1, ty1);
        const ox2 = Math.min(rx2, tx2);
        const oy2 = Math.min(ry2, ty2);
        const ow = Math.max(0, Math.floor(ox2 - ox1));
        const oh = Math.max(0, Math.floor(oy2 - oy1));
        if (ow <= 0 || oh <= 0) continue;
        const subLeft = Math.max(0, Math.floor(ox1 - tx1));
        const subTop = Math.max(0, Math.floor(oy1 - ty1));
        const dx = Math.max(0, Math.floor(ox1 - rx1));
        const dy = Math.max(0, Math.floor(oy1 - ry1));
        // Final safety clamp to avoid any off-by-one drift into base bounds
        let cW = Math.max(0, Math.min(ow, width - dx));
        let cH = Math.max(0, Math.min(oh, height - dy));
        if (cW <= 0 || cH <= 0) continue;
        const rawBuf = pm.toBinary();
        let ch = pm.channels;
        const perPx = Math.round(rawBuf.length / (pm.width * pm.height));
        if ((perPx === 3 || perPx === 4) && perPx !== pm.channels) ch = perPx;
        // Record overlay region in tile space and destination on base
        overlays.push({ pm, subLeft, subTop, dx, dy, w: cW, h: cH, ch });
        if (DBG)
          dbgOverlays.push({
            dx,
            dy,
            w: cW,
            h: cH,
            tx1,
            ty1,
            tx2,
            ty2,
            rx1,
            ry1,
            rx2,
            ry2,
            subLeft,
            subTop,
          });
      }
      if (overlays.length) {
        // Manual compositing into a raw RGBA canvas to avoid sharp composite constraints
        const baseArr = new Uint8Array(width * height * 4);
        // leave as transparent initially
        for (const o of overlays) {
          const pm = o.pm;
          const raw = pm.toBinary();
          const tileStride = pm.width * o.ch;
          const baseStride = width * 4;
          const copyW = o.w;
          const copyH = o.h;
          const a255 = o.ch === 4 ? null : 255;
          for (let y = 0; y < copyH; y++) {
            const srcRow = (o.subTop + y) * tileStride + o.subLeft * o.ch;
            const dstRow = (o.dy + y) * baseStride + o.dx * 4;
            for (let x = 0; x < copyW; x++) {
              const s = srcRow + x * o.ch;
              const d = dstRow + x * 4;
              baseArr[d] = raw[s];
              baseArr[d + 1] = raw[s + 1];
              baseArr[d + 2] = raw[s + 2];
              baseArr[d + 3] = o.ch === 4 ? raw[s + 3] : a255;
            }
          }
        }
        let outImg = sharp(Buffer.from(baseArr), {
          raw: { width, height, channels: 4 },
        });

        // Optional privacy blur overlays
        let comps = [];
        try {
          if (!wantBlur) throw new Error('blur disabled');
          const store = globalState.registry.metadataIndex?.store;
          if (store) {
            const MD = 'http://example.org/metadata#';
            const RDFT = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
            const BLUR = `${MD}PrivacyAction`;
            const ACTION = `${MD}action`;
            const TARGET = `${MD}target`;
            const actions = store
              .getQuads(null, namedNode(RDFT), namedNode(BLUR), null)
              .map((q) => q.subject.value);
            for (const a of actions) {
              const actVal = store.getQuads(
                namedNode(a),
                namedNode(ACTION),
                null,
                null,
              )[0]?.object?.value;
              const tgt = store.getQuads(
                namedNode(a),
                namedNode(TARGET),
                null,
                null,
              )[0]?.object?.value;
              if (actVal !== 'blur' || !tgt) continue;
              const reg = globalState.registry.regionManager.regions.find(
                (r) => r.metadata?.uri === tgt,
              );
              if (!reg) continue;
              const bb = reg.boundary;
              const rx1 = left,
                ry1 = top,
                rx2 = left + width,
                ry2 = top + height;
              const ox1 = Math.max(rx1, Math.floor(bb.x1));
              const oy1 = Math.max(ry1, Math.floor(bb.y1));
              const ox2 = Math.min(rx2, Math.ceil(bb.x2));
              const oy2 = Math.min(ry2, Math.ceil(bb.y2));
              let ow = Math.max(0, ox2 - ox1);
              let oh = Math.max(0, oy2 - oy1);
              if (ow <= 0 || oh <= 0) continue;
              let dx = Math.max(0, ox1 - left);
              let dy = Math.max(0, oy1 - top);
              if (dx >= width || dy >= height) continue;
              if (dx + ow > width) ow = Math.max(0, width - dx);
              if (dy + oh > height) oh = Math.max(0, height - dy);
              if (ow <= 0 || oh <= 0) continue;
              const patch = await outImg
                .clone()
                .extract({ left: dx, top: dy, width: ow, height: oh })
                .blur(15)
                .png()
                .toBuffer();
              comps.push({ input: patch, left: dx, top: dy });
            }
          }
        } catch (_) {
          // optional
        }

        let composed;
        try {
          const base = comps.length ? outImg.clone().composite(comps) : outImg;
          composed = await base
            .resize({
              width: size,
              height: size,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png()
            .toBuffer();
        } catch (_e) {
          const fallback =
            wantBlur && comps.length ? outImg.clone().blur(15) : outImg.clone();
          composed = await fallback
            .resize({
              width: size,
              height: size,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png()
            .toBuffer();
        }
        return res.type('image/png').send(composed);
      }
    }

    // As a last resort, try to crop from original file in INPUT_DIR
    // Resolve source image path by base name match in INPUT_DIR
    try {
      const files = (await fs.promises.readdir(INPUT_DIR)).filter((f) =>
        /\.(jpe?g|png|tiff?|webp)$/i.test(f),
      );
      for (const fn of files) {
        const base = path.parse(fn).name;
        if (
          base === imageName ||
          base.toLowerCase() === imageName.toLowerCase()
        ) {
          srcPath = path.join(INPUT_DIR, fn);
          break;
        }
      }
      if (srcPath) {
        // Clamp to the source image bounds before extracting
        const meta = await sharp(srcPath).metadata();
        const W = meta.width || 0;
        const H = meta.height || 0;
        // normalize and clamp
        if (width < 0) {
          left = left + width;
          width = -width;
        }
        if (height < 0) {
          top = top + height;
          height = -height;
        }
        left = Math.max(0, Math.min(left, Math.max(0, W - 1)));
        top = Math.max(0, Math.min(top, Math.max(0, H - 1)));
        width = Math.max(1, Math.min(width, Math.max(1, W - left)));
        height = Math.max(1, Math.min(height, Math.max(1, H - top)));

        const size = Math.max(
          24,
          Math.min(1024, parseInt(req.query.size || '240', 10) || 240),
        );
        let img = sharp(srcPath).extract({ left, top, width, height });

        // Optional blur overlays
        let comps = [];
        try {
          if (!wantBlur) throw new Error('blur disabled');
          const store = globalState.registry.metadataIndex?.store;
          if (store) {
            const MD = 'http://example.org/metadata#';
            const RDFT = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
            const BLUR = `${MD}PrivacyAction`;
            const ACTION = `${MD}action`;
            const TARGET = `${MD}target`;
            const actions = store
              .getQuads(null, namedNode(RDFT), namedNode(BLUR), null)
              .map((q) => q.subject.value);
            for (const a of actions) {
              const actVal = store.getQuads(
                namedNode(a),
                namedNode(ACTION),
                null,
                null,
              )[0]?.object?.value;
              const tgt = store.getQuads(
                namedNode(a),
                namedNode(TARGET),
                null,
                null,
              )[0]?.object?.value;
              if (actVal !== 'blur' || !tgt) continue;
              const reg = globalState.registry.regionManager.regions.find(
                (r) => r.metadata?.uri === tgt,
              );
              if (!reg) continue;
              const bb = reg.boundary;
              const rx1 = left,
                ry1 = top,
                rx2 = left + width,
                ry2 = top + height;
              const ox1 = Math.max(rx1, Math.floor(bb.x1));
              const oy1 = Math.max(ry1, Math.floor(bb.y1));
              const ox2 = Math.min(rx2, Math.ceil(bb.x2));
              const oy2 = Math.min(ry2, Math.ceil(bb.y2));
              let ow = Math.max(0, ox2 - ox1);
              let oh = Math.max(0, oy2 - oy1);
              if (ow <= 0 || oh <= 0) continue;
              let dx = Math.max(0, ox1 - left);
              let dy = Math.max(0, oy1 - top);
              if (dx >= width || dy >= height) continue;
              if (dx + ow > width) ow = Math.max(0, width - dx);
              if (dy + oh > height) oh = Math.max(0, height - dy);
              if (ow <= 0 || oh <= 0) continue;
              const patch = await img
                .clone()
                .extract({ left: dx, top: dy, width: ow, height: oh })
                .blur(15)
                .png()
                .toBuffer();
              comps.push({ input: patch, left: dx, top: dy });
            }
          }
        } catch (_) {
          // optional
        }
        let buf;
        try {
          const base = comps.length ? img.clone().composite(comps) : img;
          buf = await base
            .resize({
              width: size,
              height: size,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png()
            .toBuffer();
        } catch (_e) {
          const fallback =
            wantBlur && comps.length ? img.clone().blur(15) : img.clone();
          buf = await fallback
            .resize({
              width: size,
              height: size,
              fit: 'inside',
              withoutEnlargement: true,
            })
            .png()
            .toBuffer();
        }
        return res.type('image/png').send(buf);
      }
    } catch (_) {
      // ignore and fall through
    }

    return res.status(404).send('source image not found');
  } catch (e) {
    logger.warn('global/crop failed', e);
    res.status(500).send(e.message);
  }
});

/* ═══════════════════════════════════════════════════════════
   POST /global/rel – create a relationship between two URIs
   Body: { relation: 'near'|'contains'|'sameObjectAs', uriA, uriB, name?, description? }
   ═════════════════════════════════════════════════════════ */
app.post('/global/rel', express.json(), async (req, res) => {
  try {
    if (!globalState.registry?.metadataIndex)
      return res.status(400).json({ error: 'Global registry not loaded' });
    const { relation, uriA, uriB, name, description } = req.body || {};
    if (!relation || !uriA || !uriB)
      return res.status(400).json({ error: 'relation, uriA, uriB required' });
    const fn = {
      near: OntologyExt.insertNearRelationship,
      contains: OntologyExt.insertContainsRelationship,
      sameObjectAs: OntologyExt.insertSameObjectAs,
    }[relation];
    if (!fn) return res.status(400).json({ error: 'unsupported relation' });
    fn(globalState.registry.metadataIndex, uriA, uriB);
    // Optional human-friendly meta
    try {
      const baseP = {
        near: 'http://example.org/near',
        contains: 'http://example.org/contains',
        sameObjectAs: 'http://example.org/sameObjectAs',
      }[relation];
      if (name)
        OntologyExt.setRelationshipName(
          globalState.registry.metadataIndex,
          uriA,
          baseP,
          uriB,
          String(name),
        );
      if (description)
        OntologyExt.setRelationshipDescription(
          globalState.registry.metadataIndex,
          uriA,
          baseP,
          uriB,
          String(description),
        );
    } catch (_) {
      // intentionally ignore errors from ensureImageScoping
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* POST /sparql  – run against the in-memory store */
app.post('/sparql', async (req, res) => {
  try {
    const sparql = req.body.toString(); // plain text body
    const sockId = req.query.sockId ? String(req.query.sockId) : null;
    const includeDeleted = String(req.query.includeDeleted || '0') === '1';

    const bindings = await qe
      .queryBindings(sparql, { sources: [state.metadataIndex.store] })
      .then((s) => s.toArray());

    /* strip leading “?” from binding names so the table header looks nice */
    const rows = bindings.map((b) =>
      Object.fromEntries(
        [...b].map(([k, v]) => [
          k.value.startsWith('?') ? k.value.slice(1) : k.value,
          v.value,
        ]),
      ),
    );

    // Emit highlights back to a specific socket when provided
    if (sockId && Array.isArray(bindings) && bindings.length) {
      try {
        const ids = bindings
          .flatMap((b) => [
            b.get('r')?.value,
            b.get('s')?.value,
            b.get('o')?.value,
          ])
          .filter(Boolean)
          .map((uri) => state.uriToRegionId.get(uri))
          .filter((id) => id != null)
          // filter out deleted unless includeDeleted
          .filter((id) => {
            const r = state.regionManager.regions.find((x) => x.id === id);
            return includeDeleted || !r?.metadata?.deleted;
          })
          .map((id) => unifyId(id));
        if (ids.length) io.to(sockId).emit('highlightRegions', ids);
      } catch (e) {
        logger.warn(
          'emit highlightRegions failed for /sparql',
          e?.message || e,
        );
      }
    }

    res.json(rows);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* GET /loadImage */
app.get('/loadImage', async (req, res) => {
  try {
    let p = req.query.jsonPath;
    if (!p) return res.status(400).send('jsonPath missing');

    // Accept web-relative paths like "/output/foo.json" and map to OS path
    if (p.startsWith('/output/')) {
      p = path.join(OUT_DIR, p.replace(/^\/output\//, ''));
    }
    // On Windows-style backslashes coming from UI, normalize
    p = p.replace(/\\/g, '/');

    // Path safety: ensure resolved path is inside OUT_DIR
    const resolved = path.resolve(p);
    const outResolved = path.resolve(OUT_DIR);
    if (
      !resolved.startsWith(outResolved + path.sep) &&
      resolved !== outResolved
    ) {
      return res.status(400).send('jsonPath must be within /output');
    }

    state.currentJsonPath = resolved;
    state.imagePrefix = imgPrefix(resolved);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));

    if (raw.tileManifest) {
      state.isTiled = true;
      const {
        tiles,
        metadataIndex: mi,
        regionManager: rm,
      } = await TiledMLSerializer.load(resolved);
      Object.assign(state, {
        loadedTiles: tiles,
        regionManager: rm,
        metadataIndex: mi,
      });
      instrumentStore(state.metadataIndex.store);
      normaliseRM(state.regionManager, state.imagePrefix, 'tiledImage');

      const maxX = Math.max(...tiles.map((t) => t.x + t.pixelMatrix.width));
      const maxY = Math.max(...tiles.map((t) => t.y + t.pixelMatrix.height));

      // Build merged source list for audit view
      const MERGED_FROM = 'http://example.org/mergedFrom';
      const uriToId = new Map(
        state.regionManager.regions.map((r) => [r.metadata?.uri, r.id]),
      );
      const mergedSources = state.metadataIndex.store
        .getQuads(null, null, null, null)
        .filter((q) => q.predicate.value === MERGED_FROM)
        .map((q) => ({
          src: q.object.value,
          target: q.subject.value,
          targetId: uriToId.get(q.subject.value) || null,
        }));

      res.json({
        isTiled: true,
        width: maxX,
        height: maxY,
        tileManifest: tiles.map((t, i) => ({
          x: t.x,
          y: t.y,
          width: t.pixelMatrix.width,
          height: t.pixelMatrix.height,
          file: `tile_${i}.pht`,
        })),
        regions: state.regionManager.regions.filter(
          (r) => !r.metadata?.deleted,
        ),
        // include full set for audit (client may choose to show grey-listed)
        allRegions: state.regionManager.regions,
        mergedSources,
      });
      rebuildUriMaps();
    } else {
      state.isTiled = false;
      const ser = new Serializer(null, null, null);
      const {
        pixelMatrix: pm,
        metadataIndex: mi,
        regionManager: rm,
      } = await ser.load(resolved);
      Object.assign(state, {
        pixelMatrix: pm,
        regionManager: rm,
        metadataIndex: mi,
      });
      instrumentStore(state.metadataIndex.store);
      normaliseRM(state.regionManager, state.imagePrefix, 'singleImage');

      // Build merged source list for audit view
      const MERGED_FROM = 'http://example.org/mergedFrom';
      const uriToId = new Map(rm.regions.map((r) => [r.metadata?.uri, r.id]));
      const mergedSources = state.metadataIndex.store
        .getQuads(null, null, null, null)
        .filter((q) => q.predicate.value === MERGED_FROM)
        .map((q) => ({
          src: q.object.value,
          target: q.subject.value,
          targetId: uriToId.get(q.subject.value) || null,
        }));

      res.json({
        isTiled: false,
        width: pm.width,
        height: pm.height,
        tileManifest: [],
        regions: rm.regions.filter((r) => !r.metadata?.deleted),
        // include full set for audit (client may choose to show grey-listed)
        allRegions: rm.regions,
        mergedSources,
      });
      rebuildUriMaps();
    }
    logger.info('📂 loaded', path.basename(resolved));
  } catch (e) {
    logger.error(e);
    res.status(500).send(e.message);
  }
});

/* GET /export/ttl  – Export full knowledge graph in Turtle
   Query params:
     - jsonPath: optional; when provided, loads that manifest before export.
     - save=1:   optional; when set, also writes a copy to output/<base>.ttl on disk.
*/
app.get('/export/ttl', async (req, res) => {
  try {
    let exportStore = state.metadataIndex.store;
    let baseName = null;
    const p0 = req.query.jsonPath ? String(req.query.jsonPath) : null;
    if (p0) {
      let p = p0;
      if (p.startsWith('/output/')) {
        p = path.join(OUT_DIR, p.replace(/^\/output\//, ''));
      }
      p = p.replace(/\\/g, '/');
      // Path safety: ensure resolved path is inside OUT_DIR
      const resolved = path.resolve(p);
      const outResolved = path.resolve(OUT_DIR);
      if (
        !resolved.startsWith(outResolved + path.sep) &&
        resolved !== outResolved
      ) {
        return res.status(400).send('# jsonPath must be within /output');
      }
      // Load the specified JSON to ensure we export its full graph
      const data = JSON.parse(await fs.promises.readFile(resolved, 'utf8'));
      // Rehydrate a store using MetadataIndex.fromJSON for correctness
      const mi = await MetadataIndex.fromJSON(data.metadataIndex);
      exportStore = mi.store;
      baseName = path.basename(resolved, '.json');
    } else if (state.currentJsonPath) {
      baseName = path.basename(state.currentJsonPath, '.json');
    }
    const turtle = await storeToTTL(exportStore);
    // Optional: also save to disk
    const doSave = String(req.query.save || '0') === '1';
    if (doSave) {
      const bn = baseName || 'graph';
      const outPath = path.join(OUT_DIR, `${bn}.ttl`);
      await fs.promises.writeFile(outPath, turtle, 'utf8');
    }
    res.setHeader('Content-Type', 'text/turtle; charset=utf-8');
    res.send(turtle);
  } catch (e) {
    res.status(500).send(`# export failed: ${e.message}`);
  }
});

/* ════════════════════════════════════════════════════════
   POST /highlight   – return bounding-boxes for a SPARQL result
   expects the query to bind ?r (region URI)
   ═════════════════════════════════════════════════════ */
app.post('/highlight', async (req, res) => {
  try {
    const sparql = req.body.toString(); // plain-text body
    const includeDeleted = String(req.query.includeDeleted || '0') === '1';
    const bindings = await qe
      .queryBindings(sparql, { sources: [state.metadataIndex.store] })
      .then((s) => s.toArray());

    /* collect possible URI columns: ?r, ?s, ?o */
    const uris = new Set();
    for (const b of bindings) {
      const r = b.get('r')?.value;
      const s = b.get('s')?.value;
      const o = b.get('o')?.value;
      if (r) uris.add(r);
      if (s) uris.add(s);
      if (o) uris.add(o);
    }

    /* convert region URI → boundary + deleted flag */
    const idToRegion = new Map(
      state.regionManager.regions.map((r) => [r.id, r]),
    );
    const boxes = Array.from(uris)
      .map((uri) => {
        const id = state.uriToRegionId.get(uri);
        const b = state.uriToBoundary.get(uri);
        if (id == null || !b) return null;
        const reg = idToRegion.get(id) || null;
        const deleted = !!reg?.metadata?.deleted;
        if (deleted && !includeDeleted) return null;
        return { uri, deleted, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
      })
      .filter(Boolean);

    res.json(boxes);
  } catch (e) {
    logger.error(e);
    res.status(400).json({ error: e.message });
  }
});

/* GET /relationships – fast relationship listing for a URI (no SPARQL) */
app.get('/relationships', (req, res) => {
  try {
    const uri = String(req.query.uri || '');
    if (!uri) return res.status(400).json({ error: 'uri missing' });
    const useGlobal = String(req.query.global || '0') === '1';
    const store =
      useGlobal && globalState.registry?.metadataIndex?.store
        ? globalState.registry.metadataIndex.store
        : state.metadataIndex.store;
    if (process.env.DEBUG) {
      const MD = 'http://example.org/metadata#';
      const total = store.size;
      const nN = store.getQuads(
        null,
        namedNode(`${MD}relationshipName`),
        null,
        null,
      ).length;
      const nD = store.getQuads(
        null,
        namedNode(`${MD}relationshipDescription`),
        null,
        null,
      ).length;
      logger.info('[GET /relationships] store size + meta counts', {
        total,
        nN,
        nD,
      });
    }
    const out = listRelationships(store, uri, REL, DELREL);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* GET /getTile – returns a PNG for either the single image or a specific tile */
app.get('/getTile', async (req, res) => {
  try {
    // Dynamic manifest load if jsonPath provided (enables headless privacy eval)
    const requestedJson = req.query.jsonPath && String(req.query.jsonPath);
    if (requestedJson && requestedJson !== state.currentJsonPath) {
      try {
        if (!fs.existsSync(requestedJson))
          throw new Error('manifest not found');
        const raw = JSON.parse(fs.readFileSync(requestedJson, 'utf-8'));
        // Heuristic: tiled vs single based on tileManifest presence
        if (Array.isArray(raw.tileManifest)) {
          // lightweight loader: just store manifest + regions JSON; pixels come from .pht tile files as usual
          state.isTiled = true;
          state.loadedTiles = raw.tileManifest.map((t) => ({
            x: t.x,
            y: t.y,
            pixelMatrix: {
              toBinary: () =>
                fs.readFileSync(
                  path.join(path.dirname(requestedJson), t.phtFile),
                ),
              width: t.width,
              height: t.height,
              channels: t.channels,
            },
          }));
          // Regions & metadata if present
          if (raw.regionManager) state.regionManager = raw.regionManager; // contains regions+boundaries
          if (raw.metadataIndex) state.metadataIndex = raw.metadataIndex; // may contain RDF quads
        } else {
          // Single image manifest: must reconstruct pixelMatrix from linked .pht? (Not stored) – skip unless already loaded
          // Fallback: if not able to build pixelMatrix, keep existing state
        }
        state.currentJsonPath = requestedJson;
      } catch (_e) {
        // ignore dynamic load failure; continue with current state
      }
    }
    const wantBlur = String(req.query.blur || '1') !== '0';
    if (state.isTiled) {
      const i = Number(req.query.index || 0);
      if (!Number.isFinite(i) || i < 0 || i >= state.loadedTiles.length)
        return res.status(404).send('tile index out of range');
      const t = state.loadedTiles[i];
      const pm = t.pixelMatrix;
      const rawBuf = pm.toBinary();
      let ch = pm.channels;
      const perPx = Math.round(rawBuf.length / (pm.width * pm.height));
      if ((perPx === 3 || perPx === 4) && perPx !== pm.channels) ch = perPx;
      let img = sharp(rawBuf, {
        raw: { width: pm.width, height: pm.height, channels: ch },
      });

      // Optional: apply face blurring for privacy if actions present
      try {
        if (!wantBlur) throw new Error('blur disabled');
        const MD = 'http://example.org/metadata#';
        const BLUR = `${MD}PrivacyAction`;
        const ACTION = `${MD}action`;
        const TARGET = `${MD}target`;
        const actions = state.metadataIndex.store
          .getQuads(null, null, null, null)
          .filter(
            (q) =>
              q.predicate.value ===
                'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' &&
              q.object.value === BLUR,
          )
          .map((q) => q.subject.value);
        let composites = [];
        for (const a of actions) {
          const actVal = state.metadataIndex.store.getQuads(
            namedNode(a),
            namedNode(ACTION),
            null,
            null,
          )[0]?.object?.value;
          const tgt = state.metadataIndex.store.getQuads(
            namedNode(a),
            namedNode(TARGET),
            null,
            null,
          )[0]?.object?.value;
          if (actVal !== 'blur' || !tgt) continue;
          const reg = state.regionManager.regions.find(
            (r) => r.metadata?.uri === tgt,
          );
          if (!reg) continue;
          const b = reg.boundary;
          // Convert full-image coords to tile-local
          const left = Math.max(0, Math.round(b.x1 - t.x));
          const top = Math.max(0, Math.round(b.y1 - t.y));
          let width = Math.max(0, Math.round(b.x2 - b.x1));
          let height = Math.max(0, Math.round(b.y2 - b.y1));
          // Clamp to tile bounds to avoid out-of-bounds extracts
          width = Math.max(0, Math.min(pm.width - left, width));
          height = Math.max(0, Math.min(pm.height - top, height));
          if (width <= 0 || height <= 0) continue;
          const region = await img
            .clone()
            .extract({ left, top, width, height })
            .blur(15)
            .png()
            .toBuffer();
          composites.push({ input: region, left, top });
        }
        if (composites.length) img = img.composite(composites);
      } catch (_) {
        // soft-fail: do not block tile serving on blur issues
      }

      const png = await img.png().toBuffer();
      res.type('image/png').send(png);
    } else {
      if (!state.pixelMatrix) return res.status(404).send('no image loaded');
      const pm = state.pixelMatrix;
      const rawBuf = pm.toBinary();
      let ch = pm.channels;
      const perPx = Math.round(rawBuf.length / (pm.width * pm.height));
      if ((perPx === 3 || perPx === 4) && perPx !== pm.channels) ch = perPx;
      let img = sharp(rawBuf, {
        raw: { width: pm.width, height: pm.height, channels: ch },
      });

      // Apply face blur if PrivacyAction exists (single image)
      try {
        if (!wantBlur) throw new Error('blur disabled');
        const MD = 'http://example.org/metadata#';
        const RDFT = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
        const BLUR = `${MD}PrivacyAction`;
        const ACTION = `${MD}action`;
        const TARGET = `${MD}target`;
        const actions = state.metadataIndex.store
          .getQuads(null, namedNode(RDFT), namedNode(BLUR), null)
          .map((q) => q.subject.value);
        let composites = [];
        for (const a of actions) {
          const actVal = state.metadataIndex.store.getQuads(
            namedNode(a),
            namedNode(ACTION),
            null,
            null,
          )[0]?.object?.value;
          const tgt = state.metadataIndex.store.getQuads(
            namedNode(a),
            namedNode(TARGET),
            null,
            null,
          )[0]?.object?.value;
          if (actVal !== 'blur' || !tgt) continue;
          const reg = state.regionManager.regions.find(
            (r) => r.metadata?.uri === tgt,
          );
          if (!reg) continue;
          const b = reg.boundary;
          const left = Math.max(0, Math.round(b.x1));
          const top = Math.max(0, Math.round(b.y1));
          let width = Math.max(0, Math.round(b.x2 - b.x1));
          let height = Math.max(0, Math.round(b.y2 - b.y1));
          // Clamp to full image bounds
          width = Math.max(0, Math.min(pm.width - left, width));
          height = Math.max(0, Math.min(pm.height - top, height));
          if (width <= 0 || height <= 0) continue;
          const region = await img
            .clone()
            .extract({ left, top, width, height })
            .blur(15)
            .png()
            .toBuffer();
          composites.push({ input: region, left, top });
          // persist md:privacyApplied flag for audit
          try {
            upsert(tgt, { privacyApplied: true });
          } catch (_) {
            // non-fatal: persisting audit flag failed
          }
        }
        if (composites.length) img = img.composite(composites);
      } catch (_) {
        // soft-fail: privacy blur is optional; keep serving original image
      }

      const png = await img.png().toBuffer();
      res.type('image/png').send(png);
    }
  } catch (e) {
    logger.error('getTile failed', e);
    res.status(500).send(e.message);
  }
});

io.on('connection', (sock) => {
  logger.info('▶ client', sock.id, 'connected');

  sock.on('updateRegion', (data) => {
    const {
      regionId,
      newTags,
      newMeta,
      boundary,
      ontologyAction,
      relationName,
      relationDescription,
    } = data;
    const uid = /^manual-|^region-/.test(regionId)
      ? regionId
      : unifyId(regionId);

    let r = state.regionManager.regions.find((x) => x.id === uid);
    if (!r) {
      r = {
        id: uid,
        boundary: boundary || { x1: 0, y1: 0, x2: 0, y2: 0 },
        tags: newTags || [],
        metadata: { ...newMeta },
      };
      state.regionManager.regions.push(r);
      logger.info('Created', uid);
    } else {
      if (newTags) r.tags = newTags;
      if (newMeta) r.metadata = { ...r.metadata, ...newMeta };
      if (boundary) r.boundary = boundary;
      delete r.metadata.deleted;
      logger.info('Updated', uid);
    }

    if (!r.metadata.uri) {
      const seg = uid.startsWith('manual-') ? 'manual-region' : 'region';
      r.metadata.uri = `uri://${state.imagePrefix}/${seg}/${uid}`;
    }

    upsert(r.metadata.uri, { ...r.metadata, tags: r.tags });

    // Guarantee image scoping for this region via ex:within
    try {
      const subj = namedNode(r.metadata.uri);
      const WITHIN = namedNode('http://example.org/within');
      const imgIri = namedNode(`urn:image:${state.imagePrefix}`);
      const hasWithin =
        state.metadataIndex.store.getQuads(subj, WITHIN, null, null).length > 0;
      if (!hasWithin)
        state.metadataIndex.store.addQuad(quad(subj, WITHIN, imgIri));
    } catch (_) {
      // ignore: metadataIndex not initialised or store unavailable yet
    }

    if (ontologyAction?.relation) {
      const { relation, uriA, uriB } = ontologyAction;
      ({
        near: OntologyExt.insertNearRelationship,
        contains: OntologyExt.insertContainsRelationship,
        sameObjectAs: OntologyExt.insertSameObjectAs,
      })[relation]?.(state.metadataIndex, uriA, uriB);
      // Persist optional human metadata on the relationship via reification using the BASE predicate
      if (
        relationName &&
        typeof relationName === 'string' &&
        relationName.trim()
      ) {
        const baseP = REL[relation];
        if (baseP) {
          OntologyExt.setRelationshipName(
            state.metadataIndex,
            uriA,
            baseP,
            uriB,
            relationName.trim(),
          );
        }
      }
      if (
        relationDescription &&
        typeof relationDescription === 'string' &&
        relationDescription.trim()
      ) {
        const baseP = REL[relation];
        if (baseP) {
          OntologyExt.setRelationshipDescription(
            state.metadataIndex,
            uriA,
            baseP,
            uriB,
            relationDescription.trim(),
          );
        }
      }
      // Notify relationship panel(s) to refresh for both endpoints
      io.emit('relationshipsUpdated', { subject: uriA });
      io.emit('relationshipsUpdated', { subject: uriB });
      // Global page may mirror these region changes
      try {
        io.emit('regionsChanged');
      } catch (_e) {
        /* optional */
      }
      scheduleSave();
    }

    io.emit('regionUpdated', { regionId: uid, region: r });
    try {
      io.emit('regionsChanged');
    } catch (_e) {
      /* optional */
    }
  });

  // Soft toggle relationships (move between active and deleted predicate variants)
  sock.on('toggleRelationship', ({ subject, predicate, object, enabled }) => {
    try {
      if (!subject || !predicate || !object) return;
      if (!ALL_REL_P.has(predicate)) return; // only known rels
      const key = toKey(predicate);
      if (!key) return;
      const activeP = REL[key];
      const deletedP = DELREL[key];
      const s = namedNode(subject);
      const o = namedNode(object);
      // Remove both forms to avoid duplicates
      state.metadataIndex.store.removeQuad(s, namedNode(activeP), o);
      state.metadataIndex.store.removeQuad(s, namedNode(deletedP), o);
      // Add the chosen form
      const addP = enabled ? activeP : deletedP;
      state.metadataIndex.store.addQuad(s, namedNode(addP), o);
      io.emit('relationshipsUpdated', { subject });
      scheduleSave();
    } catch (e) {
      logger.warn('toggleRelationship failed', e);
    }
  });

  // Global: Soft toggle relationships and persist to contributing manifests
  sock.on(
    'toggleRelationshipGlobal',
    async ({ subject, predicate, object, enabled }) => {
      try {
        if (!globalState.registry?.metadataIndex) return;
        if (!subject || !predicate || !object) return;
        if (!ALL_REL_P.has(predicate)) return;
        const key = toKey(predicate);
        if (!key) return;
        const activeP = REL[key];
        const deletedP = DELREL[key];
        const sNN = namedNode(subject);
        const oNN = namedNode(object);
        // Toggle in global store
        const gStore = globalState.registry.metadataIndex.store;
        gStore.removeQuad(sNN, namedNode(activeP), oNN);
        gStore.removeQuad(sNN, namedNode(deletedP), oNN);
        gStore.addQuad(sNN, namedNode(enabled ? activeP : deletedP), oNN);
        io.emit('relationshipsUpdated', { subject });

        // Persist in each contributing source that contains either endpoint
        const sources = globalState.registry.sources || [];
        for (const src of sources) {
          const store = src?.metadataIndex?.store;
          if (!store) continue;
          const hasS = store.getQuads(sNN, null, null, null).length > 0;
          const hasO = store.getQuads(oNN, null, null, null).length > 0;
          if (!hasS && !hasO) continue;
          store.removeQuad(sNN, namedNode(activeP), oNN);
          store.removeQuad(sNN, namedNode(deletedP), oNN);
          store.addQuad(sNN, namedNode(enabled ? activeP : deletedP), oNN);
          try {
            if (Array.isArray(src.tiles) && src.tiles.length)
              await TiledMLSerializer.save(
                src.tiles,
                src.metadataIndex,
                src.regionManager,
                src.path,
              );
            else
              await new Serializer(
                src.pixelMatrix,
                src.metadataIndex,
                src.regionManager,
              ).save(src.path);
          } catch (e) {
            logger.warn(
              'toggleRelationshipGlobal: save failed for',
              src.path,
              e?.message || e,
            );
          }
        }
      } catch (e) {
        logger.warn('toggleRelationshipGlobal failed', e);
      }
    },
  );

  // Update metadata of an existing relationship (name/description)
  sock.on(
    'updateRelationshipMeta',
    ({ subject, predicate, object, name, description }) => {
      try {
        if (!subject || !predicate || !object) return;
        if (!ALL_REL_P.has(predicate)) return; // only known rels
        const key = toKey(predicate);
        if (!key) return;
        const baseP = REL[key];
        // If the active relation exists only in reverse orientation, attach metadata to that direction
        const sNN = namedNode(subject);
        const oNN = namedNode(object);
        const pNN = namedNode(baseP);
        const hasForward =
          state.metadataIndex.store.getQuads(sNN, pNN, oNN, null).length > 0;
        const hasReverse =
          state.metadataIndex.store.getQuads(oNN, pNN, sNN, null).length > 0;
        const metaS = hasForward || !hasReverse ? subject : object;
        const metaO = hasForward || !hasReverse ? object : subject;
        if (process.env.DEBUG) {
          logger.info('[updateRelationshipMeta]', {
            subject,
            predicate,
            object,
            name,
            description,
            metaS,
            metaO,
          });
        }
        // Centralized set/clear + history mirroring
        updateRelMetaWithHistory(
          state.metadataIndex,
          metaS,
          baseP,
          metaO,
          name,
          description,
        );
        if (process.env.DEBUG) {
          const MD = 'http://example.org/metadata#';
          const stmtIri = OntologyExt.stmtIRI(metaS, baseP, metaO);
          const cN = state.metadataIndex.store.getQuads(
            namedNode(stmtIri),
            namedNode(`${MD}relationshipName`),
            null,
            null,
          ).length;
          const cD = state.metadataIndex.store.getQuads(
            namedNode(stmtIri),
            namedNode(`${MD}relationshipDescription`),
            null,
            null,
          ).length;
          const gN = state.metadataIndex.store.getQuads(
            null,
            namedNode(`${MD}relationshipName`),
            null,
            null,
          ).length;
          const gD = state.metadataIndex.store.getQuads(
            null,
            namedNode(`${MD}relationshipDescription`),
            null,
            null,
          ).length;
          const any = state.metadataIndex.store.getQuads(
            namedNode(stmtIri),
            null,
            null,
            null,
          );
          logger.info('[updateRelationshipMeta] post-set counts', {
            cN,
            cD,
            gN,
            gD,
            stmtIri,
            any: any.length,
          });
          if (any.length) {
            logger.info(
              '[updateRelationshipMeta] stmt triples',
              any.map(
                (q) =>
                  `${q.subject.value} ${q.predicate.value} ${q.object.value}`,
              ),
            );
          }
          setTimeout(() => {
            const afterN = state.metadataIndex.store.getQuads(
              null,
              namedNode(`${MD}relationshipName`),
              null,
              null,
            ).length;
            const afterD = state.metadataIndex.store.getQuads(
              null,
              namedNode(`${MD}relationshipDescription`),
              null,
              null,
            ).length;
            const laterAny = state.metadataIndex.store.getQuads(
              namedNode(stmtIri),
              null,
              null,
              null,
            );
            logger.info('[updateRelationshipMeta] delayed check', {
              afterN,
              afterD,
              laterAny: laterAny.length,
            });
          }, 200);
        }
        io.emit('relationshipsUpdated', { subject });
        scheduleSave();
      } catch (e) {
        logger.warn('updateRelationshipMeta failed', e);
      }
    },
  );

  // Global: Update name/description and persist to contributing manifests
  sock.on(
    'updateRelationshipMetaGlobal',
    async ({ subject, predicate, object, name, description }) => {
      try {
        if (!globalState.registry?.metadataIndex) return;
        if (!subject || !predicate || !object) return;
        if (!ALL_REL_P.has(predicate)) return; // only known rels
        const key = toKey(predicate);
        if (!key) return;
        const baseP = REL[key];
        const gIndex = globalState.registry.metadataIndex;
        const gStore = gIndex.store;
        const sNN = namedNode(subject);
        const oNN = namedNode(object);
        const pNN = namedNode(baseP);
        const hasForward = gStore.getQuads(sNN, pNN, oNN, null).length > 0;
        const hasReverse = gStore.getQuads(oNN, pNN, sNN, null).length > 0;
        // Update the orientation(s) that actually exist. If both exist (e.g., sameObjectAs), update both.
        const targets = [];
        if (hasForward) targets.push([subject, object]);
        if (hasReverse) targets.push([object, subject]);
        if (!targets.length) targets.push([subject, object]); // fallback

        for (const [s, o] of targets)
          updateRelMetaWithHistory(gIndex, s, baseP, o, name, description);

        // Persist to each contributing source
        const sources = globalState.registry.sources || [];
        for (const src of sources) {
          const store = src?.metadataIndex?.store;
          if (!store) continue;
          const hasF =
            store.getQuads(
              namedNode(subject),
              namedNode(baseP),
              namedNode(object),
              null,
            ).length > 0;
          const hasR =
            store.getQuads(
              namedNode(object),
              namedNode(baseP),
              namedNode(subject),
              null,
            ).length > 0;
          if (!(hasF || hasR)) continue;
          const perSrcTargets = [];
          if (hasF) perSrcTargets.push([subject, object]);
          if (hasR) perSrcTargets.push([object, subject]);
          for (const [s, o] of perSrcTargets)
            updateRelMetaWithHistory(
              src.metadataIndex,
              s,
              baseP,
              o,
              name,
              description,
            );
          try {
            if (Array.isArray(src.tiles) && src.tiles.length)
              await TiledMLSerializer.save(
                src.tiles,
                src.metadataIndex,
                src.regionManager,
                src.path,
              );
            else
              await new Serializer(
                src.pixelMatrix,
                src.metadataIndex,
                src.regionManager,
              ).save(src.path);
          } catch (_e) {
            logger.warn(
              'updateRelationshipMetaGlobal: save failed for',
              src.path,
              _e?.message || _e,
            );
          }
        }

        io.emit('relationshipsUpdated', { subject });
      } catch (e) {
        logger.warn('updateRelationshipMetaGlobal failed', e);
      }
    },
  );

  sock.on('deleteRegion', (data) => {
    let rid = /^manual-|^region-/.test(data.regionId)
      ? data.regionId
      : unifyId(data.regionId);
    const r = state.regionManager.regions.find((x) => x.id === rid);
    if (!r) return;
    r.metadata.deleted = true;

    upsert(r.metadata.uri, { ...r.metadata, tags: r.tags, deleted: true });

    state.metadataIndex.store.addQuad(
      namedNode(r.metadata.uri),
      namedNode('http://www.w3.org/2002/07/owl#deprecated'),
      literal('true', namedNode('http://www.w3.org/2001/XMLSchema#boolean')),
    );

    logger.info('soft-deleted', rid);
    io.emit('regionDeleted', { regionId: rid, soft: true });
    try {
      io.emit('regionsChanged');
    } catch (_e) {
      /* optional */
    }
    scheduleSave();
  });

  // Helper: detect pairs-style queries (s/o with predicate)
  function isPairsQuery(sparql) {
    if (!sparql) return false;
    const hasSO =
      /\?[so]\b/i.test(sparql) &&
      /\?s\b/i.test(sparql) &&
      /\?o\b/i.test(sparql);
    const hasPred =
      /rdf:predicate\s+\?pred/i.test(sparql) ||
      /VALUES\s+\?pred/i.test(sparql) ||
      /\?s\s+\?pred\s+\?o/i.test(sparql);
    return hasSO && hasPred;
  }

  // Helper: should include deleted variants based on question wording
  function wantsDeleted(question) {
    const q = String(question || '');
    return /(include\s+deleted|even\s+removed|deleted\s+too|removed\s+too|also\s+deleted|including\s+deleted)/i.test(
      q,
    );
  }

  // Helper: expand VALUES ?pred {...} to include overlaps/sameObjectAs (+ deleted variants optionally)
  function expandPairsPredicates(sparql, includeDeleted) {
    if (!sparql) return sparql;
    const base = ['md:near', 'md:contains', 'md:sameObjectAs', 'md:overlaps'];
    const delMap = {
      'md:near': 'md:deletedNear',
      'md:contains': 'md:deletedContains',
      'md:sameObjectAs': 'md:deletedSameObjectAs',
      'md:overlaps': 'md:deletedOverlaps',
    };
    // Collect existing tokens from first VALUES block (if any)
    const re = /VALUES\s+\?pred\s*\{([^}]*)\}/gi;
    let m;
    const present = new Set();
    while ((m = re.exec(sparql))) {
      const body = m[1] || '';
      body
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => /^md:/.test(t))
        .forEach((t) => present.add(t));
    }
    // Final token set: union present + base
    base.forEach((t) => present.add(t));
    if (includeDeleted) {
      [...present].forEach((t) => {
        const del = delMap[t];
        if (del) present.add(del);
      });
    }
    const replacement = `VALUES ?pred { ${[...present].join(' ')} }`;
    // Replace all VALUES blocks with the unified set
    return sparql.replace(/VALUES\s+\?pred\s*\{[^}]*\}/gi, replacement);
  }

  // Ensure pairs queries project ?s and ?o so UI can highlight and show a table
  function ensurePairsProjection(sparql) {
    try {
      if (!sparql || !isPairsQuery(sparql)) return sparql;
      const re = /SELECT\s+(DISTINCT\s+)?([\s\S]*?)\bWHERE\b/i;
      const m = sparql.match(re);
      if (!m) return sparql;
      const distinct = m[1] || '';
      const varlist = m[2] || '';
      const hasS = /\?s(\s|$)/i.test(varlist);
      const hasO = /\?o(\s|$)/i.test(varlist);
      if (hasS && hasO) return sparql;
      // Keep original vars but ensure ?s and ?o are present
      const parts = varlist
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (!hasS) parts.unshift('?s');
      if (!hasO) parts.unshift('?o');
      const newHead = `SELECT ${distinct}${parts.join(' ')} WHERE`;
      const out = sparql.replace(re, newHead);
      if (process.env.DEBUG)
        logger.info('[Viewer] Adjusted projection to include ?s ?o');
      return out;
    } catch (_e) {
      return sparql;
    }
  }

  // voice query
  sock.on('voiceBlob', async ({ wavBase64, imageId }) => {
    try {
      const wavBuf = Buffer.from(wavBase64, 'base64');
      // Normalize imageId to an absolute IRI early to avoid relative IRI issues downstream
      const normalizedImageId =
        typeof imageId === 'string' && /^(?:[a-z]+:|uri:\/\/)/i.test(imageId)
          ? imageId
          : 'urn:image:' + String(imageId || state.imagePrefix);
      const {
        question,
        sparql: initialSparql,
        raw,
      } = await bufferToSPARQL(
        wavBuf,
        os.tmpdir(),
        normalizedImageId,
        /*isWebm=*/ true,
      );

      if (!initialSparql || !initialSparql.trim())
        throw new Error(
          'LLM produced empty query – try again or refine the prompt',
        );

      let effectiveSparql = ensurePairsProjection(initialSparql);
      logger.info('Voice →', question, '\nSPARQL →\n', effectiveSparql);

      /* ───── run the query once ───── */
      let bindings = await state.metadataIndex.executeSPARQL(effectiveSparql);

      // Empty? If it's a pairs query, broaden predicates and retry once
      if (!bindings.length && isPairsQuery(effectiveSparql)) {
        const broadened = ensurePairsProjection(
          expandPairsPredicates(effectiveSparql, wantsDeleted(question)),
        );
        if (broadened && broadened !== effectiveSparql) {
          logger.info('Retry with broadened predicates');
          bindings = await state.metadataIndex.executeSPARQL(broadened);
          if (bindings.length) effectiveSparql = broadened; // send back the broadened query used
        }
      }

      /* Plain rows for the data table */
      const rows = bindings.map((b) =>
        Object.fromEntries(
          [...b].map(([k, v]) => [
            k.value && k.value.startsWith('?') ? k.value.slice(1) : k.value,
            v.value,
          ]),
        ),
      );

      /* ids for yellow highlight: prefer ?r, else also consider ?s and ?o */
      const collectUris = (b) => {
        const out = [];
        const r = b.get('r')?.value;
        const s = b.get('s')?.value;
        const o = b.get('o')?.value;
        if (r) out.push(r);
        if (s) out.push(s);
        if (o) out.push(o);
        return out;
      };
      const regionIds = bindings
        .flatMap(collectUris)
        .filter(Boolean)
        .map((uri) => state.uriToRegionId.get(uri))
        .filter((id) => id != null)
        .map((id) => unifyId(id));

      // Send rawAnswer for debugging
      sock.emit('sparqlOk', {
        question,
        sparql: effectiveSparql,
        rows,
        rawAnswer: raw,
      });
      if (regionIds.length) sock.emit('highlightRegions', regionIds);
    } catch (e) {
      sock.emit('sparqlErr', e.message);
    }
  });

  // chat (text) → SPARQL (bypass STT, invoke LLM directly)
  sock.on('chatAsk', async ({ question, imageId }) => {
    try {
      const normalizedImageId =
        typeof imageId === 'string' && /^(?:[a-z]+:|uri:\/\/)/i.test(imageId)
          ? imageId
          : 'urn:image:' + String(imageId || state.imagePrefix);
      const { questionToSPARQL } = await import('../voice/VoiceService.js');
      const { sparql: initialSparql } = await questionToSPARQL(
        question || '',
        normalizedImageId,
      );

      let effectiveSparql = ensurePairsProjection(initialSparql);
      let bindings = await state.metadataIndex.executeSPARQL(effectiveSparql);
      if (!bindings.length && isPairsQuery(effectiveSparql)) {
        const broadened = ensurePairsProjection(
          expandPairsPredicates(effectiveSparql, wantsDeleted(question)),
        );
        if (broadened && broadened !== effectiveSparql) {
          logger.info('Retry(chat) with broadened predicates');
          bindings = await state.metadataIndex.executeSPARQL(broadened);
          if (bindings.length) effectiveSparql = broadened;
        }
      }
      const rows = bindings.map((b) =>
        Object.fromEntries(
          [...b].map(([k, v]) => [
            k.value && k.value.startsWith('?') ? k.value.slice(1) : k.value,
            v.value,
          ]),
        ),
      );
      // collect ids for highlights like voice handler
      const collectUris = (b) => {
        const out = [];
        const r = b.get('r')?.value,
          s = b.get('s')?.value,
          o = b.get('o')?.value;
        if (r) out.push(r);
        if (s) out.push(s);
        if (o) out.push(o);
        return out;
      };
      const regionIds = bindings
        .flatMap(collectUris)
        .filter(Boolean)
        .map((uri) => state.uriToRegionId.get(uri))
        .filter((id) => id != null)
        .map((id) => unifyId(id));

      sock.emit('sparqlOk', {
        question,
        sparql: effectiveSparql,
        rows,
        rawAnswer: '',
      });
      if (regionIds.length) sock.emit('highlightRegions', regionIds);
    } catch (e) {
      sock.emit('sparqlErr', e.message || String(e));
    }
  });

  // ─── Global: voice and chat handlers against global registry ───
  sock.on('voiceBlobGlobal', async ({ wavBase64 }) => {
    try {
      if (!globalState.registry?.metadataIndex)
        throw new Error('Global registry not loaded');
      const wavBuf = Buffer.from(wavBase64, 'base64');
      const normalizedImageId = 'urn:image:GLOBAL';
      const {
        question,
        sparql: initialSparql,
        raw,
      } = await bufferToSPARQL(
        wavBuf,
        os.tmpdir(),
        normalizedImageId,
        /*isWebm=*/ true,
      );

      if (!initialSparql || !initialSparql.trim())
        throw new Error(
          'LLM produced empty query – try again or refine the prompt',
        );

      let effectiveSparql = initialSparql;
      const bindings =
        await globalState.registry.metadataIndex.executeSPARQL(effectiveSparql);

      const rows = bindings.map((b) =>
        Object.fromEntries(
          [...b].map(([k, v]) => [
            k.value && k.value.startsWith('?') ? k.value.slice(1) : k.value,
            v.value,
          ]),
        ),
      );
      const collectUris = (b) => {
        const out = [];
        const r = b.get('r')?.value,
          s = b.get('s')?.value,
          o = b.get('o')?.value;
        if (r) out.push(r);
        if (s) out.push(s);
        if (o) out.push(o);
        return out;
      };
      const regionIds = bindings
        .flatMap(collectUris)
        .filter(Boolean)
        .map((uri) => globalState.uriToRegionId.get(uri))
        .filter((id) => id != null);

      sock.emit('sparqlOkGlobal', {
        question,
        sparql: effectiveSparql,
        rows,
        rawAnswer: raw,
      });
      if (regionIds.length) sock.emit('highlightRegionsGlobal', regionIds);
    } catch (e) {
      sock.emit('sparqlErrGlobal', e.message || String(e));
    }
  });

  sock.on('chatAskGlobal', async ({ question }) => {
    try {
      if (!globalState.registry?.metadataIndex)
        throw new Error('Global registry not loaded');
      const normalizedImageId = 'urn:image:GLOBAL';
      const { questionToSPARQL } = await import('../voice/VoiceService.js');
      const { sparql: initialSparql } = await questionToSPARQL(
        question || '',
        normalizedImageId,
      );
      let effectiveSparql = initialSparql;
      const bindings =
        await globalState.registry.metadataIndex.executeSPARQL(effectiveSparql);
      const rows = bindings.map((b) =>
        Object.fromEntries(
          [...b].map(([k, v]) => [
            k.value && k.value.startsWith('?') ? k.value.slice(1) : k.value,
            v.value,
          ]),
        ),
      );
      const collectUris = (b) => {
        const out = [];
        const r = b.get('r')?.value,
          s = b.get('s')?.value,
          o = b.get('o')?.value;
        if (r) out.push(r);
        if (s) out.push(s);
        if (o) out.push(o);
        return out;
      };
      const regionIds = bindings
        .flatMap(collectUris)
        .filter(Boolean)
        .map((uri) => globalState.uriToRegionId.get(uri))
        .filter((id) => id != null);
      sock.emit('sparqlOkGlobal', { question, sparql: effectiveSparql, rows });
      if (regionIds.length) sock.emit('highlightRegionsGlobal', regionIds);
    } catch (e) {
      sock.emit('sparqlErrGlobal', e.message || String(e));
    }
  });
  sock.once('disconnect', () => logger.info('◀ client', sock.id, 'bye'));
});

app.get('/saveChanges', async (_, res) => {
  try {
    if (!state.currentJsonPath)
      return res.status(400).json({ error: 'no JSON' });
    if (state.isTiled)
      await TiledMLSerializer.save(
        state.loadedTiles,
        state.metadataIndex,
        state.regionManager,
        state.currentJsonPath,
      );
    else
      await new Serializer(
        state.pixelMatrix,
        state.metadataIndex,
        state.regionManager,
      ).save(state.currentJsonPath);
    logger.info('💾 saved', path.basename(state.currentJsonPath));
    res.json({ message: 'saved' });
  } catch (e) {
    logger.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* ─── run ────────────────────────────────────────────────── */
server.listen(PORT, () =>
  logger.info('InteractiveViewerServer running @', PORT),
);
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    logger.error(
      `Port ${PORT} is already in use. Set PORT to a free port (e.g., 3001) and restart.`,
    );
  } else {
    logger.error('Server error:', err?.message || err);
  }
  process.exit(1);
});

/* ─── NL2SPARQL simple endpoint (heuristic) ─────────────────── */
import express from 'express';
app.post('/nl2sparql/text', express.json(), async (req, res) => {
  try {
    const utterance = (req.body?.utterance || '').toLowerCase();
    if (!globalState.registry?.metadataIndex)
      return res.json({
        error: 'registry not loaded',
        sparql: null,
        results: [],
      });
    let sparql = null;
    if (/how many regions/.test(utterance)) {
      sparql = 'SELECT (COUNT(?r) AS ?count) WHERE { ?r a ?type . }';
    } else if (
      /list .*class labels|list all region class labels/.test(utterance)
    ) {
      sparql =
        'SELECT DISTINCT ?label WHERE { ?r a ?t ; <http://example.org/classLabel> ?label . }';
    } else if (/how many (people|persons|faces)/.test(utterance)) {
      sparql =
        'SELECT (COUNT(?r) AS ?count) WHERE { ?r a <http://example.org/face> . }';
    } else {
      // default broad pattern
      sparql = 'SELECT ?r WHERE { ?r ?p ?o } LIMIT 25';
    }
    let bindings = [];
    try {
      bindings = await globalState.registry.metadataIndex.executeSPARQL(sparql);
    } catch (e) {
      return res.json({ sparql, parseError: e.message, results: [] });
    }
    const rows = bindings.map((b) =>
      Object.fromEntries([...b].map(([k, v]) => [k.value, v.value])),
    );
    res.json({ sparql, results: rows });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
