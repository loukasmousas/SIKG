// VoiceService.js – speech-to-SPARQL broker (GPT4All v4.x) with SPARQL normalization
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { transcribe } from './transcribe.js';
import { logger } from '../common/logger.js';
// Load environment variables early (fix: previous code relied on shell export only)
try {
  // Lazy require to avoid crash if package missing; will silently skip
  const dotenv = await import('dotenv').catch(() => null);
  if (dotenv?.config) dotenv.config();
} catch (e) {
  logger.warn('[VoiceService] dotenv load failed (continuing):', e.message);
}

import { loadModel } from 'gpt4all';

import ffmpeg from 'fluent-ffmpeg';
// Prefer system ffmpeg; allow override via env
try {
  const customPath = process.env.FFMPEG_PATH;
  if (customPath && typeof customPath === 'string') {
    ffmpeg.setFfmpegPath(customPath);
  }
} catch (_e) {
  // non-fatal; fluent-ffmpeg will attempt PATH lookup
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODEL_NAME =
  process.env.LLM_MODEL || 'mistral-7b-instruct-v0.1.Q4_0.gguf';
const PROJECT_ROOT = process.cwd();
const MODEL_DIR = process.env.MODELS_DIR || 'models';
const LLM_TEMP = Number.isFinite(Number(process.env.LLM_TEMP))
  ? Number(process.env.LLM_TEMP)
  : 0.2;
const LLM_NPRED = Number.isFinite(Number(process.env.LLM_NPREDICT))
  ? Number(process.env.LLM_NPREDICT)
  : 128; // slightly smaller default to speed up
const DEFAULT_LIMIT = Number.isFinite(Number(process.env.SPARQL_DEFAULT_LIMIT))
  ? Number(process.env.SPARQL_DEFAULT_LIMIT)
  : 200;

// Relationship constants are maintained centrally (used implicitly via md: prefixed tokens in SPARQL here)

// ---- Intent schema (lightweight validation, no extra deps) ----
// Contract:
// {
//   target: 'regions' | 'pairs',
//   image?: string,               // e.g., urn:image:42
//   types?: string[],             // e.g., ["ex:person"]
//   relationships?: { predicates?: (keyof REL)[], direction?: 'either'|'out'|'in', includeDeleted?: boolean },
//   metaFilters?: { name?: { equals?: string, contains?: string }, description?: { contains?: string }, tags?: string[] },
//   projection?: { vars?: string[], limit?: number, orderBy?: { var: string, dir: 'asc'|'desc' } }
// }
export function validateIntent(obj) {
  const fail = (m) => ({ ok: false, error: String(m) });
  if (!obj || typeof obj !== 'object') return fail('intent must be an object');
  const out = {};
  const tgt = obj.target;
  if (tgt !== 'regions' && tgt !== 'pairs')
    return fail('target must be regions or pairs');
  out.target = tgt;
  if (obj.image != null) out.image = String(obj.image);
  if (Array.isArray(obj.types))
    out.types = obj.types.map(String).filter(Boolean);
  if (obj.relationships && typeof obj.relationships === 'object') {
    const r = obj.relationships;
    const predicates = Array.isArray(r.predicates)
      ? r.predicates
          .map(String)
          .filter((k) =>
            ['near', 'contains', 'sameObjectAs', 'overlaps'].includes(k),
          )
      : [];
    const direction = ['either', 'out', 'in'].includes(r.direction)
      ? r.direction
      : 'either';
    const includeDeleted = !!r.includeDeleted;
    out.relationships = { predicates, direction, includeDeleted };
  }
  if (obj.metaFilters && typeof obj.metaFilters === 'object') {
    const mf = {};
    if (obj.metaFilters.name && typeof obj.metaFilters.name === 'object') {
      const n = obj.metaFilters.name;
      const name = {};
      if (typeof n.equals === 'string') name.equals = n.equals;
      if (typeof n.contains === 'string') name.contains = n.contains;
      if (Object.keys(name).length) mf.name = name;
    }
    if (
      obj.metaFilters.description &&
      typeof obj.metaFilters.description === 'object'
    ) {
      const d = obj.metaFilters.description;
      const desc = {};
      if (typeof d.contains === 'string') desc.contains = d.contains;
      if (Object.keys(desc).length) mf.description = desc;
    }
    if (Array.isArray(obj.metaFilters.tags)) {
      mf.tags = obj.metaFilters.tags.map(String).filter(Boolean);
    }
    if (Object.keys(mf).length) out.metaFilters = mf;
  }
  if (obj.projection && typeof obj.projection === 'object') {
    const p = {};
    if (Array.isArray(obj.projection.vars))
      p.vars = obj.projection.vars.map(String).filter(Boolean);
    if (Number.isFinite(obj.projection.limit))
      p.limit = Math.max(1, Math.min(10000, Number(obj.projection.limit)));
    if (obj.projection.orderBy && typeof obj.projection.orderBy === 'object') {
      const ob = obj.projection.orderBy;
      const dir = String(ob.dir).toLowerCase();
      if (ob.var && ['asc', 'desc'].includes(dir))
        p.orderBy = { var: String(ob.var), dir };
    }
    if (Object.keys(p).length) out.projection = p;
  }
  return { ok: true, value: out };
}

export function buildSparqlFromIntent(intent) {
  const px = [
    'PREFIX ex:   <http://example.org/>',
    'PREFIX rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
    'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
    'PREFIX md:   <http://example.org/metadata#>',
  ];
  const q = [];
  const limit = intent?.projection?.limit ?? DEFAULT_LIMIT;

  if (intent.target === 'regions') {
    const requested = intent?.projection?.vars?.length
      ? intent.projection.vars
      : [];
    // If user didn't ask for specific vars or only requested ?r, enrich the projection with common metadata
    const vars =
      !requested.length || (requested.length === 1 && requested[0] === 'r')
        ? ['r', 'classLabel', 'label', 'tag', 'confidence', 'privacyApplied']
        : requested;
    q.push(`SELECT ${vars.map((v) => '?' + v).join(' ')} WHERE {`);
    // core binding: region var
    if (!vars.includes('r')) q.push('  BIND(?r AS ?r)'); // ensure ?r should exist when needed
    // Prepare image filter triple for proper placement with UNIONs
    let imageTriple = null;
    if (intent.image) {
      // Normalize image to absolute IRI: if missing a scheme, assume urn:image:<name>
      const img = String(intent.image);
      const imgIri = /^(?:[a-z]+:|uri:\/\/)/i.test(img)
        ? img
        : `urn:image:${img}`;
      imageTriple = `?r ex:within <${imgIri}> .`;
    }
    // Type filters (generalized): for each type T, match via rdf:type T OR md:classLabel == localName(T) OR md:tags contains localName(T)
    if (Array.isArray(intent.types) && intent.types.length) {
      const types = intent.types;
      types.forEach((t, i) => {
        const tStr = String(t);
        // derive a lowercase local label for tags/classLabel comparisons
        const local = (tStr.includes(':') ? tStr.split(':').pop() : tStr)
          .split(/[/#]/)
          .pop();
        const label = String(local || '')
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '');
        const vSuf = i + 1; // avoid var collisions
        // Build the UNION group for this type
        q.push('  {');
        q.push(`    { ?r a ${tStr} . }`);
        q.push('    UNION');
        q.push(
          `    { ?r md:classLabel ?cl${vSuf} . FILTER(LCASE(STR(?cl${vSuf})) = "${label}") . }`,
        );
        q.push('    UNION');
        q.push(
          `    { ?r md:tags ?tag${vSuf} . FILTER(CONTAINS(LCASE(STR(?tag${vSuf})), "${label}")) . }`,
        );
        q.push('  }');
      });
      // Apply image filter once so it joins with all type patterns
      if (imageTriple) q.push('  ' + imageTriple);
    } else if (imageTriple) {
      // No type constraints; just apply image filter if present
      q.push('  ' + imageTriple);
    }
    // Tags
    if (intent.metaFilters?.tags?.length) {
      q.push('  ?r md:tags ?tag .');
      const terms = intent.metaFilters.tags.map((t) => t.toLowerCase());
      q.push(
        '  FILTER(' +
          terms
            .map(
              (t) => `CONTAINS(LCASE(STR(?tag)), "${t.replace(/"/g, '\\"')}")`,
            )
            .join(' || ') +
          ') .',
      );
    }
    // Always expose helpful metadata for display
    q.push('  OPTIONAL { ?r md:classLabel ?classLabel . }');
    q.push('  OPTIONAL { ?r rdfs:label ?label . }');
    q.push('  OPTIONAL { ?r md:tags ?tag . }');
    q.push('  OPTIONAL { ?r md:confidence ?confidence . }');
    q.push('  OPTIONAL { ?r md:privacyApplied ?privacyApplied . }');
    q.push('}');
  } else if (intent.target === 'pairs') {
    const requested = intent?.projection?.vars?.length
      ? intent.projection.vars
      : [];
    const vars =
      !requested.length ||
      (requested.length === 2 &&
        requested.includes('s') &&
        requested.includes('o'))
        ? ['s', 'o', 'pred', 'name', 'desc']
        : requested;
    q.push(`SELECT ${vars.map((v) => '?' + v).join(' ')} WHERE {`);
    // Relationship predicates filter (support 1+ predicates via VALUES)
    const preds = intent.relationships?.predicates?.length
      ? intent.relationships.predicates
      : ['near', 'contains', 'sameObjectAs', 'overlaps'];
    const allPredIris = [];
    for (const k of preds) {
      allPredIris.push(`md:${k}`);
      if (intent.relationships?.includeDeleted) {
        const del = `md:deleted${k.charAt(0).toUpperCase()}${k.slice(1)}`;
        allPredIris.push(del);
      }
    }
    // Support both direct triples and reified statements via UNION
    q.push('  {');
    q.push('    ?s ?pred ?o .');
    if (allPredIris.length)
      q.push(`    VALUES ?pred { ${allPredIris.join(' ')} }`);
    q.push('  }');
    q.push('  UNION');
    q.push('  {');
    q.push('    ?stmt a rdf:Statement ;');
    q.push('          rdf:subject ?s ;');
    q.push('          rdf:predicate ?pred ;');
    q.push('          rdf:object ?o .');
    if (allPredIris.length)
      q.push(`    VALUES ?pred { ${allPredIris.join(' ')} }`);
    // Always bind relationship metadata for display
    q.push('    OPTIONAL { ?stmt (md:relationshipName|rdfs:label) ?_nm . }');
    q.push('    OPTIONAL { ?stmt md:relationshipDescription ?desc . }');
    q.push('  }');
    // Optional image scoping: when image present, scope both ends to same image
    if (intent.image) {
      const img = String(intent.image);
      const imgIri = /^(?:[a-z]+:|uri:\/\/)/i.test(img)
        ? img
        : `urn:image:${img}`;
      q.push(`  ?s ex:within <${imgIri}> .`);
      q.push(`  ?o ex:within <${imgIri}> .`);
    }
    // Direction: either/out/in means I keep subject/object as is. For "in", swap later in projection if needed.
    // Meta filters on name/description
    if (intent.metaFilters?.name?.equals) {
      const v = intent.metaFilters.name.equals.toLowerCase();
      q.push(`  FILTER(BOUND(?_nm) && LCASE(STR(?_nm)) = "${v}") .`);
    } else if (intent.metaFilters?.name?.contains) {
      const v = intent.metaFilters.name.contains.toLowerCase();
      q.push(`  FILTER(BOUND(?_nm) && CONTAINS(LCASE(STR(?_nm)), "${v}")) .`);
    }
    if (intent.metaFilters?.description?.contains) {
      const v = intent.metaFilters.description.contains
        .toLowerCase()
        .replace(/"/g, '\\"');
      q.push(`  FILTER(BOUND(?desc) && CONTAINS(LCASE(STR(?desc)), "${v}")) .`);
    }
    q.push('}');
    // Direction handling: I keep ?s ?o; callers can swap client-side if needed. Keeping simple.
  }

  let sparql = px.join('\n') + '\n' + q.join('\n');
  if (limit && /SELECT/i.test(sparql) && !/LIMIT\s+\d+/i.test(sparql)) {
    sparql += `\nLIMIT ${limit}`;
  }
  return sparql;
}

// Derive timeout (previously defaulted silently to 30000 if env not loaded)
let parsedTimeout = Number(process.env.LLM_TIMEOUT_MS);
if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
  parsedTimeout = 60000; // safer default
}
let LLM_TIMEOUT_MS = parsedTimeout;
logger.info(
  `[VoiceService] Using LLM model="${MODEL_NAME}" timeout=${LLM_TIMEOUT_MS}ms modelsDir=${MODEL_DIR}`,
);

let modelPromise = null;
async function resolveModelFile() {
  // Optional absolute override
  const override = process.env.LLM_MODEL_FILE;
  const exists = async (p) =>
    !!(await fs
      .access(p)
      .then(() => true)
      .catch(() => false));

  // If override is set and inside project, use a project-relative path
  if (override) {
    const relFromRoot = path.isAbsolute(override)
      ? path.relative(PROJECT_ROOT, override)
      : override;
    const abs = path.isAbsolute(override)
      ? override
      : path.join(PROJECT_ROOT, override);
    if (await exists(abs)) {
      if (!relFromRoot.startsWith('..')) return relFromRoot;
      // outside project root; avoid absolute usage per policy
      throw new Error(
        'LLM_MODEL_FILE must point inside the project directory. Place the model under ./models',
      );
    }
  }

  // Try as absolute or relative to MODEL_DIR
  const directAbs = path.isAbsolute(MODEL_NAME)
    ? MODEL_NAME
    : path.join(PROJECT_ROOT, MODEL_DIR, MODEL_NAME);
  if (await exists(directAbs)) return path.join(MODEL_DIR, MODEL_NAME);

  // Try common alias: swap dots/underscores in version segment (v0.1 <-> v0_1)
  const swapped = MODEL_NAME.replace(/v(\d+)\.(\d+)/, 'v$1_$2');
  const swapped2 = MODEL_NAME.replace(/v(\d+)_(\d+)/, 'v$1.$2');
  for (const alt of [swapped, swapped2]) {
    if (alt !== MODEL_NAME) {
      const abs = path.join(PROJECT_ROOT, MODEL_DIR, alt);
      if (await exists(abs)) return path.join(MODEL_DIR, alt);
    }
  }

  // As a last resort, search the folder for a close match
  try {
    const dirAbs = path.join(PROJECT_ROOT, MODEL_DIR);
    const files = await fs.readdir(dirAbs);
    const want = MODEL_NAME.replace(/[._-]/g, '').toLowerCase();
    const cand = files
      .filter((f) => /\.gguf$/i.test(f))
      .find((f) => f.replace(/[._-]/g, '').toLowerCase().includes(want));
    if (cand) return path.join(MODEL_DIR, cand);
  } catch {
    // ignore directory read errors (e.g., models dir missing)
  }

  throw new Error(
    `Model file not found. Checked LLM_MODEL_FILE and ${path.join(MODEL_DIR, MODEL_NAME)}. Place the .gguf under ${MODEL_DIR}/`,
  );
}
async function getModel() {
  if (modelPromise) return modelPromise;
  const modelRel = await resolveModelFile();
  const modelName = path.basename(modelRel);
  const modelPathRel = path.dirname(modelRel) || '.';
  logger.info(
    `[VoiceService] loading LLM from file: ${path.join(modelPathRel, modelName)}`,
  );

  // Build a sanitized local model list (array form) to satisfy gpt4all v4
  const cfgSourceRel = path.join(modelPathRel, 'models3.local.json');
  const cfgSourceAbs = path.join(PROJECT_ROOT, cfgSourceRel);
  const cfgRel = path.join(modelPathRel, 'models3.local.sanitized.json');
  const cfgAbs = path.join(PROJECT_ROOT, cfgRel);
  let arrayList = null;
  const src = await fs.readFile(cfgSourceAbs, 'utf8').catch(() => null);
  if (src) {
    try {
      const parsed = JSON.parse(src);
      if (Array.isArray(parsed)) arrayList = parsed;
      else if (parsed && Array.isArray(parsed.models))
        arrayList = parsed.models;
    } catch {
      // ignore malformed JSON, fall back to default arrayList below
    }
  }
  if (!Array.isArray(arrayList)) {
    arrayList = [{ filename: modelName }];
  }
  await fs
    .writeFile(cfgAbs, JSON.stringify(arrayList, null, 2), 'utf8')
    .catch(() => {});

  modelPromise = loadModel(modelName, {
    modelPath: modelPathRel, // folder relative to project root
    modelConfigFile: cfgRel, // relative JSON model list
    allowDownload: false,
    verbose: true,
    device: 'cpu',
    nCtx: 2048,
  });
  await modelPromise;
  return modelPromise;
}

const FEW_SHOT = `
You are an assistant that outputs only valid SPARQL 1.1 queries, nothing else.

PREFIX ex: <http://example.org/>
# Relationships are modeled via RDF reification with optional labels and descriptions.
# Use md:near, md:contains, md:sameObjectAs and their deleted variants when asked to include deleted.
# Pattern:
#   ?stmt a rdf:Statement ;
#         rdf:subject ?s ;
#         rdf:predicate md:near ;
#         rdf:object ?o .
#   OPTIONAL { ?stmt (md:relationshipName|rdfs:label) ?name . }
#   OPTIONAL { ?stmt md:relationshipDescription ?desc . }

Each image is <urn:image:<id>>.
Bounding boxes have types such as ex:person, ex:boat, ex:car.

  Guidelines:
  - If the question scopes to a specific image, add both ?s ex:within <urn:image:...> and ?o ex:within <urn:image:...> for pair queries.
  - For phrases like "inside", "within" → md:contains; "same", "identical", "duplicate" → md:sameObjectAs; "near", "close", "adjacent" → md:near.
  - When unsure which predicate, include multiple via VALUES (e.g., near and contains and sameObjectAs).
  - If the user mentions deleted/removed, include the md:deleted* variants alongside active ones.
  - If asked to "highlight" relationships or regions generally, prefer selecting ?s ?o for pairs or ?r for regions.
  - When selecting regions by a class (e.g., person/boat/car), match via a UNION of: rdf:type, md:classLabel (lowercased), or md:tags (substring, lowercased).
  - If the user says "here" or "this image", assume the current image context and scope accordingly.

Examples:
Q: "How many boats are here?"
A: PREFIX ex: <http://example.org/>
  SELECT (COUNT(*) AS ?cnt) WHERE { ?r a ex:boat }

Q: "show every person"
A: PREFIX ex: <http://example.org/>
  PREFIX md:  <http://example.org/metadata#>
  SELECT ?r WHERE {
    { ?r a ex:person }
    UNION { ?r md:classLabel ?cl . FILTER(LCASE(STR(?cl)) = "person") }
    UNION { ?r md:tags ?tag . FILTER(CONTAINS(LCASE(STR(?tag)), "person")) }
  }

Q: "persons in image 42 only"
A: PREFIX ex: <http://example.org/>
  PREFIX md:  <http://example.org/metadata#>
  SELECT ?r WHERE {
    { ?r a ex:person }
    UNION { ?r md:classLabel ?cl . FILTER(LCASE(STR(?cl)) = "person") }
    UNION { ?r md:tags ?tag . FILTER(CONTAINS(LCASE(STR(?tag)), "person")) }
    ?r ex:within <urn:image:42> .
  }

Q: "show pairs named owner (near or contains) in image 42"
A: PREFIX ex: <http://example.org/>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  PREFIX md:  <http://example.org/metadata#>
  SELECT ?s ?o WHERE {
    ?stmt a rdf:Statement ; rdf:subject ?s ; rdf:predicate ?pred ; rdf:object ?o .
    VALUES ?pred { md:near md:contains }
    OPTIONAL { ?stmt (md:relationshipName|rdfs:label) ?name }
    FILTER(BOUND(?name) && LCASE(STR(?name)) = "owner") .
    ?s ex:within <urn:image:42> .
    ?o ex:within <urn:image:42> .
  }

Q: "are there any relationships here? highlight them"
A: PREFIX ex: <http://example.org/>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  PREFIX md:  <http://example.org/metadata#>
  SELECT ?s ?o WHERE {
    ?stmt a rdf:Statement ; rdf:subject ?s ; rdf:predicate ?pred ; rdf:object ?o .
    VALUES ?pred { md:near md:contains md:sameObjectAs }
    ?s ex:within <urn:image:42> .
    ?o ex:within <urn:image:42> .
  }

Q: "include deleted duplicates"
A: PREFIX ex: <http://example.org/>
  PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
  PREFIX md:  <http://example.org/metadata#>
  SELECT ?s ?o WHERE {
    ?stmt a rdf:Statement ; rdf:subject ?s ; rdf:predicate ?pred ; rdf:object ?o .
    VALUES ?pred { md:sameObjectAs md:deletedSameObjectAs }
  }

(END OF EXAMPLES)
`;

async function webmToWavFile(sourceBuf, tmpDir) {
  const srcPath = path.join(tmpDir, `input_${Date.now()}.webm`);
  const wavPath = srcPath.replace(/\.webm$/, '.wav');
  await fs.writeFile(srcPath, sourceBuf);

  await new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .outputOptions('-ac', '1', '-ar', '16000')
      .save(wavPath)
      .on('end', resolve)
      .on('error', reject);
  });

  await fs.unlink(srcPath).catch(() => {});
  return wavPath;
}

let lastCall = 0;
export async function wavToSPARQLBuffer(wavPath, currentImageId) {
  const now = Date.now();
  if (now - lastCall < 500) {
    await new Promise((r) => setTimeout(r, 500));
  }
  lastCall = now;

  const questionRaw = await transcribe(wavPath);
  const question = (questionRaw || '').trim();
  if (!question)
    throw new Error('Transcription failed or produced an empty question');
  // Normalize image id for prompt clarity
  const currentImageIri =
    typeof currentImageId === 'string' &&
    /^(?:[a-z]+:|uri:\/\/)/i.test(currentImageId)
      ? currentImageId
      : `urn:image:${String(currentImageId || '')}`.replace(/:+$/, '');

  return await llmQuestionToSPARQL(question, currentImageIri);
}

// Export a text-only helper for tests and non-audio clients
export async function bufferToSPARQL(buf, tmpDir, imageId, isWebm = true) {
  const wavPath = isWebm
    ? await webmToWavFile(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), tmpDir)
    : (await fs.writeFile(
        path.join(tmpDir, `voice_${Date.now()}.wav`),
        Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
      ),
      path.join(tmpDir, `voice_${Date.now()}.wav`));

  try {
    return await wavToSPARQLBuffer(wavPath, imageId);
  } finally {
    fs.unlink(wavPath).catch(() => {});
  }
}

// Shared LLM path for both voice (after STT) and chat
async function llmQuestionToSPARQL(question, currentImageIri) {
  // Intent JSON path (preferred)
  const INTENT_GUIDE =
    `You are a helpful assistant that converts a question into a compact JSON intent.\n` +
    `Output ONLY JSON with no commentary.\n` +
    `Schema (keys optional unless noted):\n` +
    `{\n` +
    `  "target": "regions" | "pairs",\n` +
    `  "image"?: string,\n` +
    `  "types"?: string[],\n` +
    `  "relationships"?: { "predicates"?: ["near"|"contains"|"sameObjectAs"|"overlaps"], "direction"?: "either"|"out"|"in", "includeDeleted"?: boolean },\n` +
    `  "metaFilters"?: { "name"?: { "equals"?: string, "contains"?: string }, "description"?: { "contains"?: string }, "tags"?: string[] },\n` +
    `  "projection"?: { "vars"?: string[], "limit"?: number, "orderBy"?: { "var": string, "dir": "asc"|"desc" } }\n` +
    `}\n` +
    `Guidance:\n` +
    `- If the question mentions "relationship(s)", "pair(s)", or connections, set target to "pairs" and include multiple predicates via VALUES when unsure.\n` +
    `- If the user asks to "find/show/list (every|all) <class>" (e.g., person, boat, car), set target to "regions" and set types to ["ex:<classLower>"]; prefer projecting ["r"].\n` +
    `- If the user says "here", "this image", or similar, set image to the current image.\n` +
    `- For "highlight them", prefer projecting subjects/objects (e.g., vars ["s","o"]).\n` +
    `- Relationships may be stored as direct triples or reified statements; when unsure, match both using a UNION of both patterns.\n` +
    `Examples:\n` +
    `Q: "show every person" -> {"target":"regions","types":["ex:person"],"projection":{"vars":["r"],"limit":200}}\n` +
    `Q: "pairs named owner" -> {"target":"pairs","relationships":{"predicates":["near"]},"metaFilters":{"name":{"equals":"owner"}}}\n` +
    `Q: "are there any relationships here? highlight them" -> {"target":"pairs","projection":{"vars":["s","o"],"limit":200}}`;

  let llm;
  try {
    llm = await getModel();
  } catch (e) {
    logger.warn('[VoiceService] LLM unavailable:', e.message);
    throw e;
  }

  async function generateWithTimeout(prompt, genOpts) {
    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('LLM generation timeout')),
        LLM_TIMEOUT_MS,
      ),
    );
    const generation = llm.generate(prompt, genOpts);
    return Promise.race([generation, timeout]);
  }

  // Similar approaches / references for salvaging and constraining JSON from LLMs:
  // - JSON5 (lenient parser for comments, single quotes, trailing commas): https://json5.org/
  // - jsonrepair (repairs common JSON issues incl. fenced code blocks): https://github.com/josdejong/jsonrepair
  // - Grammar-constrained generation for strict JSON with llama.cpp (GBNF): https://github.com/ggerganov/llama.cpp/tree/master/grammars
  //   JSON grammar example: https://github.com/ggerganov/llama.cpp/blob/master/grammars/json.gbnf
  // Helper: parse intent JSON robustly across models that add Q:/A: or role tags
  function parseIntentJSONWithSalvage(raw) {
    const out = { ok: false, obj: null, rawJsonText: '', error: '' };
    if (!raw) return out;
    let txt = String(raw);
    txt = txt.replace(/```json|```/gi, '').trim();
    // Strip one leading role/Q&A prefix if present
    txt = txt.replace(
      /^(?:[>\s]*)?(?:Q:|A:|###\s*Human:|###\s*Assistant:|User:|Assistant:)\s*/i,
      '',
    );
    try {
      const obj = JSON.parse(txt);
      out.ok = true;
      out.obj = obj;
      out.rawJsonText = txt;
      return out;
    } catch {
      // intentionally ignore malformed JSON, fall back to default arrayList below
    }
    // Find first balanced { ... } (ignoring quoted braces)
    const s = txt;
    const start = s.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      let inStr = false;
      let q = '';
      let prev = '';
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (inStr) {
          if (ch === q && prev !== '\\') inStr = false;
        } else {
          if (ch === '"' || ch === "'") {
            inStr = true;
            q = ch;
          } else if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const cand = s.slice(start, i + 1);
              try {
                const obj = JSON.parse(cand);
                out.ok = true;
                out.obj = obj;
                out.rawJsonText = cand;
                return out;
              } catch {
                // intentionally ignore malformed JSON, fall back to default arrayList below
              }
              break;
            }
          }
        }
        prev = ch;
      }
    }
    // Minimal fix-ups for lax JSON
    let alt = txt;
    if (!/"/.test(alt) && /'/.test(alt)) alt = alt.replace(/'/g, '"');
    alt = alt.replace(/,(\s*[}\]])/g, '$1');
    try {
      const obj = JSON.parse(alt);
      out.ok = true;
      out.obj = obj;
      out.rawJsonText = alt;
      return out;
    } catch (e) {
      out.error = e.message || String(e);
      return out;
    }
  }

  try {
    const rawIntent = await generateWithTimeout(
      `${INTENT_GUIDE}\nCurrent image = ${currentImageIri}\nQ: "${question}"\nA:`,
      {
        temp: Math.min(LLM_TEMP, 0.2),
        nPredict: 256,
        stop: [
          '\nQ:',
          'Q:',
          '\n\n',
          '```',
          '</s>',
          'A:',
          '### Human:',
          '### Assistant:',
          'User:',
          'Assistant:',
        ],
      },
    );
    const txt =
      typeof rawIntent === 'string'
        ? rawIntent
        : rawIntent?.text || rawIntent?.output || '';
    const salvaged = parseIntentJSONWithSalvage(txt);
    if (salvaged.ok) {
      const v = validateIntent(salvaged.obj);
      if (v.ok) {
        const norm = normalizeIntent(question, { ...v.value }, currentImageIri);
        const sparqlFromIntent = buildSparqlFromIntent(norm);
        return {
          question,
          sparql: sparqlFromIntent,
          raw: salvaged.rawJsonText,
        };
      }
    }
    throw new Error('intent JSON not parsed');
  } catch (e) {
    if (process.env.DEBUG)
      logger.info('[VoiceService] Intent path (text) skipped:', e.message);
  }

  // Fallback to direct SPARQL generation
  const prompt = `${FEW_SHOT}\nCurrent image = ${currentImageIri}\nQ: "${question}"\nA:`;

  let answer;
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('LLM generation timeout')),
        LLM_TIMEOUT_MS,
      ),
    );
    const generation = llm.generate(prompt, {
      temp: LLM_TEMP,
      nPredict: LLM_NPRED,
      stop: [
        '\nQ:',
        '\n\n',
        '</s>',
        'Q:',
        ' A:',
        'Q "',
        'Question:',
        'Answer:',
        '```',
        '---',
      ],
    });
    answer = await Promise.race([generation, timeout]);
  } catch (err) {
    logger.warn('[VoiceService] generation failed (text):', err.message);
    throw new Error(`LLM generation failed: ${err.message}`);
  }

  function extractSPARQL(rawOut) {
    if (!rawOut) return '';
    let txt = String(rawOut).replace(/```[a-z]*\n?|```/gi, '');
    const lines = txt
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length);
    const start = lines.findIndex(
      (l) =>
        /^PREFIX\s+/i.test(l) || /^(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i.test(l),
    );
    if (start === -1) return '';
    const work = lines.slice(start);
    const prefixes = [];
    while (work.length && /^PREFIX\s+/i.test(work[0]))
      prefixes.push(work.shift());
    if (!work.length) return '';
    let queryLines = [];
    let braceDepth = 0;
    const first = work.shift();
    queryLines.push(first);
    if (/{/.test(first)) braceDepth += (first.match(/{/g) || []).length;
    if (/}/.test(first)) braceDepth -= (first.match(/}/g) || []).length;
    for (const l of work) {
      queryLines.push(l);
      if (/{/.test(l)) braceDepth += (l.match(/{/g) || []).length;
      if (/}/.test(l)) braceDepth -= (l.match(/}/g) || []).length;
      if (braceDepth <= 0 && /}/.test(l)) break;
    }
    let out = prefixes.concat(queryLines).join('\n');
    if (
      /SELECT/i.test(out) &&
      !/LIMIT\s+\d+/i.test(out) &&
      !/COUNT\s*\(/i.test(out) &&
      !/GROUP\s+BY/i.test(out)
    )
      out += `\nLIMIT ${DEFAULT_LIMIT}`;
    return out;
  }

  let raw = '';
  if (typeof answer === 'string') raw = answer;
  else if (answer) raw = answer.output || answer.text || '';
  let sparql = extractSPARQL(raw);
  // Strict LLM-only retry: if SPARQL couldn't be extracted, attempt a second intent JSON pass
  if (!sparql || !/\b(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i.test(sparql)) {
    try {
      const strictIntentPrompt =
        `${INTENT_GUIDE}\nRespond with JSON only. Start with { and include no other text.\n` +
        `Current image = ${currentImageIri}\nQ: "${question}"\nA:`;
      const retry = await (async () => {
        const timeout = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('LLM generation timeout')),
            LLM_TIMEOUT_MS,
          ),
        );
        const generation = llm.generate(strictIntentPrompt, {
          temp: Math.min(LLM_TEMP, 0.15),
          nPredict: 256,
          stop: [
            '\nQ:',
            'Q:',
            '\n\n',
            '```',
            '</s>',
            'A:',
            '### Human:',
            '### Assistant:',
            'User:',
            'Assistant:',
          ],
        });
        return Promise.race([generation, timeout]);
      })();
      const retryTxt =
        typeof retry === 'string' ? retry : retry?.text || retry?.output || '';
      const salvaged2 = parseIntentJSONWithSalvage(retryTxt);
      if (salvaged2.ok) {
        const v2 = validateIntent(salvaged2.obj);
        if (v2.ok) {
          const norm2 = normalizeIntent(
            question,
            { ...v2.value },
            currentImageIri,
          );
          const built2 = buildSparqlFromIntent(norm2);
          if (built2 && /\bSELECT\b/i.test(built2)) {
            sparql = built2;
            // Expose the strict retry JSON and log success in DEBUG mode
            raw = salvaged2.rawJsonText || raw;
            if (process.env.DEBUG)
              logger.info(
                '[VoiceService] Intent retry succeeded (strict JSON).',
              );
          }
        }
      }
    } catch (_e) {
      if (process.env.DEBUG)
        logger.info('[VoiceService] second intent retry failed:', _e.message);
    }
  }
  return { question, sparql, raw };
}

// Text question → SPARQL (bypass STT, reuse shared LLM path)
export async function questionToSPARQL(questionRaw, currentImageId = '') {
  const question = (questionRaw || '').trim();
  if (!question) return { question: '', sparql: '', raw: '' };
  const currentImageIri =
    typeof currentImageId === 'string' &&
    /^(?:[a-z]+:|uri:\/\/)/i.test(currentImageId)
      ? currentImageId
      : `urn:image:${String(currentImageId || '')}`.replace(/:+$/, '');
  return await llmQuestionToSPARQL(question, currentImageIri);
}

// Heuristics to make intent robust to general wording
function normalizeIntent(question, intent, currentImageIri) {
  const q = String(question || '');
  const out = { ...intent };
  const relWord =
    /(relationship|relationships|pair|pairs|connection|connections|link|links)/i.test(
      q,
    );
  const hereWord = /(here|this image|in this image|on this image)/i.test(q);
  const wantDeleted =
    /(include\s+deleted|even\s+removed|deleted\s+too|removed\s+too|also\s+deleted|including\s+deleted)/i.test(
      q,
    );
  const synOverlaps =
    /(overlap|overlaps|touch|touching|intersect|intersects|intersection)/i.test(
      q,
    );
  const synSame = /(duplicate|duplicates|same\s*object|identical)/i.test(q);
  // Prefer pairs when user talks about relationships OR mentions overlaps/duplicates
  if (relWord || synOverlaps || synSame) out.target = 'pairs';
  // If not a relationship query, assume regions and try to infer classes
  if (!out.target) {
    out.target = 'regions';
    // Basic class noun detection, e.g., person/people, boat(s), car(s), face(s)
    const lc = q.toLowerCase();
    const classes = [];
    const add = (t) => classes.push(`ex:${t}`);
    if (/\b(person|people|persons)\b/.test(lc)) add('person');
    if (/\b(boat|boats|ship|ships|vessel|vessels)\b/.test(lc)) add('boat');
    if (/\b(car|cars|auto|vehicle|vehicles)\b/.test(lc)) add('car');
    if (/\b(face|faces)\b/.test(lc)) add('face');
    if (/\b(tree|trees)\b/.test(lc)) add('tree');
    if (classes.length) out.types = Array.from(new Set(classes));
  }
  // Scope to current image when user says here/this image
  if (!out.image && hereWord) out.image = currentImageIri;
  // Ensure reasonable defaults for pairs
  if (out.target === 'pairs') {
    const rel = out.relationships || {};
    if (!Array.isArray(rel.predicates) || !rel.predicates.length) {
      const seeds = [];
      if (synOverlaps) seeds.push('overlaps');
      if (synSame) seeds.push('sameObjectAs');
      if (!seeds.length)
        rel.predicates = ['near', 'contains', 'sameObjectAs', 'overlaps'];
      else rel.predicates = Array.from(new Set([...seeds, 'near', 'contains']));
    }
    if (typeof rel.includeDeleted !== 'boolean') rel.includeDeleted = false;
    if (wantDeleted) rel.includeDeleted = true;
    out.relationships = rel;
    // Project s/o for highlighting if not specified
    const proj = out.projection || {};
    if (!Array.isArray(proj.vars) || !proj.vars.length) proj.vars = ['s', 'o'];
    out.projection = proj;
  } else if (out.target === 'regions') {
    // Regions: default to projecting ?r
    const proj = out.projection || {};
    if (!Array.isArray(proj.vars) || !proj.vars.length) proj.vars = ['r'];
    out.projection = proj;
  }
  // Guard image: if provided but missing scheme, convert to urn:image
  if (out.image && !/^(?:[a-z]+:|uri:\/\/)/i.test(String(out.image))) {
    out.image = `urn:image:${String(out.image)}`;
  }
  // Sanitize misleading name/description filters unless explicitly requested by the user
  try {
    const wantsName = /(named|called|label|labelled|labeled)/i.test(q);
    const imgIriLc = String(currentImageIri || '').toLowerCase();
    const imgToken = imgIriLc.replace(/^urn:image:/, '');
    const suspicious = (val) => {
      const v = String(val || '').toLowerCase();
      return (
        v === imgIriLc ||
        v.includes('urn:image:') ||
        (!!imgToken && (v === imgToken || v.includes(imgToken)))
      );
    };
    if (out.metaFilters && out.metaFilters.name) {
      const n = out.metaFilters.name;
      if (!wantsName || suspicious(n.equals) || suspicious(n.contains)) {
        delete out.metaFilters.name;
      }
    }
    if (out.metaFilters && out.metaFilters.description) {
      const d = out.metaFilters.description;
      if (suspicious(d.contains)) delete out.metaFilters.description;
    }
    if (out.metaFilters && !Object.keys(out.metaFilters).length)
      delete out.metaFilters;
  } catch (err) {
    logger.warn('metaFilter sanitization failed', err);
  }
  return out;
}
//
// Purpose: Accept browser mic input, transcode via ffmpeg, transcribe locally (Whisper),
// and generate SPARQL heuristically with a local LLM (GPT4All). Validates/executes queries
// through Comunica and returns results. Focus is on offline operation and schema‑guided prompts.
//
// References
// - Whisper: https://arxiv.org/abs/2212.04356
// - GPT4All: https://gpt4all.io/
// - Comunica SPARQL: https://comunica.dev/
