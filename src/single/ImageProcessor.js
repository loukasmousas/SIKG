// ImageProcessor.js
//
// 1.  Decodes the *entire* image (Sharp) so the viewer shows exact pixels.
// 2.  Runs COCO-SSD + DeepLab once on the full frame.
// 3.  Writes only **region‑level** metadata and provenance triples
//     - no per-pixel metadata at all.
// 4.  Uses a worker-thread pool to copy pixels into PixelMatrix
//     (zero computation inside the workers, just memory copies).
// ------------------------------------------------------------------

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

import PixelMatrix from '../common/PixelMatrix.js';
import MetadataIndex, { safeLocalName } from '../common/MetadataIndex.js';
import RegionManager from '../common/RegionManager.js';
import MLProcessor from './MLProcessor.js';
import OntologyExt from '../common/OntologyExtensions.js';
import { autoCreateRelationships as linkSpatial } from '../common/spatial-links.js';
import ADE20K_LABELS from '../../models/ade20k_labels.js';
import { logger } from '../common/logger.js';
import fs from 'fs/promises';

function sanitizeName(name) {
  return (
    (name || '')
      .toString()
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9._-]/g, '')
      .slice(0, 128) || 'image'
  );
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/* ------------------------------------------------------------- */

class ImageProcessor {
  /**
   * @param {Buffer} imageBuffer
   * @param {String} imageName
   * @param {Object} [options]
   *        mergeRegions              - boolean, default true
   *        mergeIoUThreshold         - number,  default 0.5
   *        minSegmentationConfidence - number,  default 0.7 (70%)
   *        spatialRelationships      - boolean (default true)
   *        nearDistance              - px distance for near (default 100)
   *        maxNearPairs              - cap near pairs (default 500)
   *        containsEnabled           - toggle contains (default true)
   *        nearEnabled               - toggle near (default true)
   *        minRegionAreaForNear      - skip tiny regions for near (default 25)
   *        overlapsEnabled           - emit overlaps predicate (default true)
   *        minOverlapIoU             - IoU threshold for overlaps (default 0.05)
   *        minOverlapArea            - absolute px area threshold (default 50)
   *        edgeTouchEnabled          - emit intersectsEdge when only touching edge (default true)
   *        insideRatioEnabled        - emit inside + insideRatio (default true)
   *        minInsideRatio            - minimum (A inside B area / A area) to count (default 0.9)
   */
  constructor(imageBuffer, imageName, options = {}) {
    this.imageBuffer = imageBuffer;
    this.imageName = sanitizeName(imageName);
    this.options = {
      mergeRegions: true,
      mergeIoUThreshold: 0.5,
      minSegmentationConfidence: 0.7,
      spatialRelationships: true,
      nearDistance: 100,
      maxNearPairs: 500,
      containsEnabled: true,
      nearEnabled: true,
      minRegionAreaForNear: 25,
      performanceProfile: 'balanced', // 'fast' | 'balanced' | 'quality'
      overlapsEnabled: true,
      minOverlapIoU: 0.05,
      minOverlapArea: 50,
      edgeTouchEnabled: true,
      insideRatioEnabled: true,
      minInsideRatio: 0.9,
      facePrivacy: true, // default on: enable face detection + blur action triples
      minFaceConfidence: 0.6,
      ...options,
    };

    /* keep the image identifier handy for ex:within triples */
    this.safeName = sanitizeName(options.safeName || 'singleImage');

    this.pixelMatrix = null;
    this.metadataIndex = new MetadataIndex();
    this.regionManager = new RegionManager();
    this.mlProcessor = new MLProcessor();
    this._rawModel = { detections: [], faces: [], deeplab: [] };
  }

  /* ─────────────────── automated ML regions ─────────────────── */

  async defineAutomatedRegions(timer) {
    await this.mlProcessor.loadCocoModel();
    if (this.options.performanceProfile !== 'fast') {
      await this.mlProcessor.loadDeepLabModel();
    }
    if (this.options.facePrivacy !== false) {
      await this.mlProcessor.loadFaceDetectorModel();
    }
    if (timer) timer.mark('loadModels');

    const { detections, deeplabSegmentation, faces } =
      await this.mlProcessor.detectRegions(this.imageBuffer);
    if (timer) timer.mark('detect');

    const _COCO_URI = 'http://example.org/model#COCO_SSD'; // unused (reserved for future provenance)
    const _DL_URI = 'http://example.org/model#DeepLab'; // unused (reserved for future provenance)

    /* ---------- COCO‑SSD ------------------------------------- */
    detections.forEach((det) => {
      const raw = det.class || det.label; // what TF-JS actually gives
      const local = safeLocalName(raw); // traffic light → traffic_light
      const regId = this.regionManager.defineRegion(det.boundary, [local], {
        description: `Auto: ${raw}`,
        confidence: det.score ?? det.confidence, // tfjs → score
        model: 'coco-ssd',
        classLabel: local,
      });

      const uri = `uri://${this.imageName}/singleImage/${regId}`; // unified scheme <image>/<pipeline>/<id>
      const bb = this.regionManager.regions[regId].boundary;
      this.regionManager.regions[regId].metadata.uri = uri;

      // provenance (for eval)
      this.regionManager.regions[regId].provenance = { detectedBy: 'coco-ssd' };

      /* flat JSON metadata */
      this.metadataIndex.insert(
        'region',
        this.imageName,
        { regionId: regId },
        {
          description: `Auto: ${raw}`,
          confidence: det.score ?? det.confidence,
          x: bb.x1,
          y: bb.y1,
          w: bb.x2 - bb.x1,
          h: bb.y2 - bb.y1,
          model: 'coco-ssd',
          classLabel: local,
        },
        'singleImage',
      );

      /* Turtle triples */
      this.metadataIndex.insertQuads(`
        @prefix ex:  <http://example.org/> .
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

  <${uri}>  a             ex:${local} ;
      ex:within     <urn:image:${this.safeName}> ;
      ex:x          ${bb.x1} ;
      ex:y          ${bb.y1} ;
      ex:w          ${bb.x2 - bb.x1} ;
      ex:h          ${bb.y2 - bb.y1} ;
      ex:confidence ${det.score ?? det.confidence} ;
      ex:detectedBy <http://example.org/model/coco-ssd> .
      `);
      // raw model dump capture
      this._rawModel.detections.push({
        class: local,
        score: det.score ?? det.confidence,
        x: bb.x1,
        y: bb.y1,
        w: bb.x2 - bb.x1,
        h: bb.y2 - bb.y1,
      });
    });

    /* ---------- DeepLab segmentation ------------------------- */
    if (deeplabSegmentation && this.options.performanceProfile !== 'fast') {
      const { legend, segmentationMap, width, height } = deeplabSegmentation;
      const total = segmentationMap.length;

      /* count pixels / class */
      const freq = new Map();
      for (let i = 0; i < total; i++) {
        const id = segmentationMap[i];
        freq.set(id, (freq.get(id) || 0) + 1);
      }

      freq.forEach((pix, id) => {
        if (id === 0) return; // background
        const conf = pix / total;
        if (conf < this.options.minSegmentationConfidence) return;

        const entry = legend[id] ?? {};
        const raw = entry.name || entry.label || ADE20K_LABELS[id];
        const lbl = safeLocalName(raw || `class-${id}`);

        const regId = this.regionManager.defineRegion(
          { x1: 0, y1: 0, x2: width, y2: height },
          [lbl],
          {
            description: `DeepLab class: ${lbl}`,
            confidence: conf,
            classId: id,
            classLabel: lbl,
            model: 'deeplab',
          },
        );

        const uri = `uri://${this.imageName}/singleImage/${regId}`; // unified scheme
        const bb = this.regionManager.regions[regId].boundary; // get real bbox
        this.regionManager.regions[regId].metadata.uri = uri;

        this.regionManager.regions[regId].provenance = {
          detectedBy: 'deeplab',
        };
        this.metadataIndex.insert(
          'region',
          this.imageName,
          { regionId: regId },
          {
            description: `DeepLab class: ${lbl}`,
            confidence: conf,
            classId: id,
            classLabel: lbl,
            model: 'deeplab',
            x: bb.x1,
            y: bb.y1,
            w: bb.x2 - bb.x1,
            h: bb.y2 - bb.y1,
          },
          'singleImage',
        );

        /* Turtle triples */
        this.metadataIndex.insertQuads(`
          @prefix ex:  <http://example.org/> .
          @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

          <${uri}>  a             ex:${lbl} ;
                    ex:within     <urn:image:${this.safeName}> ;
                    ex:x          ${bb.x1} ;
                    ex:y          ${bb.y1} ;
                    ex:w          ${bb.x2 - bb.x1} ;
                    ex:h          ${bb.y2 - bb.y1} ;
                    ex:confidence ${conf} ;
                    ex:detectedBy <http://example.org/model/deeplab-ade20k> .
  `);
        this._rawModel.deeplab.push({ class: lbl, score: conf });
      });
    }

    /* ---------- Face Detection (privacy) --------------------- */
    if (Array.isArray(faces) && faces.length) {
      faces
        .filter((f) => (f.confidence ?? 1) >= this.options.minFaceConfidence)
        .forEach((f) => {
          const regId = this.regionManager.defineRegion(f.boundary, ['face'], {
            description: 'Auto: face',
            confidence: f.confidence ?? 1,
            model: 'face-detection',
            classLabel: 'face',
          });
          const uri = `uri://${this.imageName}/singleImage/${regId}`;
          const bb = this.regionManager.regions[regId].boundary;
          this.regionManager.regions[regId].metadata.uri = uri;

          this.regionManager.regions[regId].provenance = {
            detectedBy: 'face-detection',
          };
          this.metadataIndex.insert(
            'region',
            this.imageName,
            { regionId: regId },
            {
              description: 'Auto: face',
              confidence: f.confidence ?? 1,
              x: bb.x1,
              y: bb.y1,
              w: bb.x2 - bb.x1,
              h: bb.y2 - bb.y1,
              model: 'face-detection',
              classLabel: 'face',
            },
            'singleImage',
          );

          // RDF: detectedBy and privacy action (planned/actual)
          this.metadataIndex.insertQuads(`
            @prefix ex:  <http://example.org/> .
            @prefix md:  <http://example.org/metadata#> .
            <${uri}>  a             ex:face ;
                      ex:within     <urn:image:${this.safeName}> ;
                      ex:x          ${bb.x1} ;
                      ex:y          ${bb.y1} ;
                      ex:w          ${bb.x2 - bb.x1} ;
                      ex:h          ${bb.y2 - bb.y1} ;
                      ex:confidence ${f.confidence ?? 1} ;
                      md:detectedBy <http://example.org/model/face-detection> .
          `);
          // Record that a blur privacy action is applicable/performed
          const action = `urn:privacy:blur:${Date.now()}:${regId}`;
          this.metadataIndex.insertQuads(`
            @prefix ex:  <http://example.org/> .
            @prefix md:  <http://example.org/metadata#> .
            <${action}> a md:PrivacyAction ; md:action "blur" ; md:target <${uri}> .
          `);
          this._rawModel.faces.push({
            confidence: f.confidence ?? 1,
            x: bb.x1,
            y: bb.y1,
            w: bb.x2 - bb.x1,
            h: bb.y2 - bb.y1,
          });
        });
    }

    if (this.options.mergeRegions) {
      const preUriMap = new Map(
        this.regionManager.regions.map((r) => [r.id, r.metadata?.uri]),
      );
      const preMergeCount = this.regionManager.regions.length;
      const prov = this.regionManager.mergeOverlappingRegions(
        this.options.mergeIoUThreshold,
      );
      if (prov && prov.some((p) => p.sources.length > 1)) {
        const ts = Date.now();
        prov.forEach((p) => {
          if (p.sources.length <= 1) return; // no real merge
          const targetRegion = this.regionManager.regions[p.target];
          if (!targetRegion.metadata) targetRegion.metadata = {};
          if (!targetRegion.metadata.uri)
            targetRegion.metadata.uri = `uri://${this.imageName}/singleImage/${targetRegion.id}`; // unified scheme
          const eventNode = `urn:merge:${this.imageName}:${ts}:${p.target}`;
          this.metadataIndex.insertQuads(
            `@prefix ex:<http://example.org/> . <${eventNode}> a ex:MergeEvent .`,
          );
          p.sources.forEach((srcId) => {
            const srcUri =
              preUriMap.get(srcId) ||
              `uri://${this.imageName}/singleImage/${srcId}`; // unified scheme
            this.metadataIndex.insertQuads(
              `@prefix ex:<http://example.org/> . <${targetRegion.metadata.uri}> ex:mergedFrom <${srcUri}> . <${srcUri}> ex:participatedInMerge <${eventNode}> .`,
            );
          });
        });
      }
      // Debug: emit merge provenance + transformation stats
      try {
        if (process.env.PHT_DEBUG_MERGE) {
          const debugDir = 'output/debug';
          await fs.mkdir(debugDir, { recursive: true });
          const debugPath = `${debugDir}/merge-debug-${this.imageName}.json`;
          const merges = (prov || [])
            .filter((p) => p.sources.length > 1)
            .map((p) => ({
              target: p.target,
              sources: p.sources,
              targetTags: this.regionManager.regions[p.target]?.tags || [],
            }));
          const payload = {
            image: this.imageName,
            rawDetectionCount: this._rawModel.detections.length,
            preMergeRegionCount: preMergeCount,
            postMergeRegionCount: this.regionManager.regions.length,
            mergeReduction: preMergeCount - this.regionManager.regions.length,
            merges,
          };
          await fs.writeFile(debugPath, JSON.stringify(payload, null, 2));
        }
        if (process.env.PHT_DEBUG_DISCARD) {
          const debugDir = 'output/debug';
          await fs.mkdir(debugDir, { recursive: true });
          const discardPath = `${debugDir}/discard-${this.imageName}.json`;
          const merges = (prov || [])
            .filter((p) => p.sources.length > 1)
            .map((p) => ({ target: p.target, sources: p.sources }));
          const payload = {
            image: this.imageName,
            rawDetections: this._rawModel.detections.length,
            finalRegions: this.regionManager.regions.length,
            scoreFiltered: [],
            centerFiltered: [],
            mergedGroups: merges,
          };
          await fs.writeFile(discardPath, JSON.stringify(payload, null, 2));
        }
      } catch (e) {
        logger.warn('merge debug emit failed', e?.message || e);
      }
    }
  }

  /* ───────────────────── pipeline driver ───────────────────── */

  async processImage(timer) {
    logger.info(`── ImageProcessor ▶ ${this.imageName}`);

    /* Decode pixels (RGBA) */
    const { data, info } = await sharp(this.imageBuffer, { failOnError: false })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });
    if (timer) timer.mark('decode');

    const { width, height, channels } = info;
    this.pixelMatrix = new PixelMatrix(width, height, channels);

    /* Run ML & create regions */
    await this.defineAutomatedRegions(timer);

    /* Materialize pixels into PixelMatrix
       - Default: worker-thread copy (existing behavior)
       - Fast path (PHT_ZERO_COPY=1|true): assign sharp raw Buffer directly to PixelMatrix
         as a Uint8Array view to avoid re-copying large images. This preserves the
         StageTimer label 'pixelCopy' (it measures materialization) for comparability.
    */
    const ZERO_COPY = /^(1|true|yes)$/i.test(
      String(process.env.PHT_ZERO_COPY || ''),
    );
    if (ZERO_COPY) {
      logger.info('[single] Pixel materialization: ZERO-COPY active');
      // Re-point the PixelMatrix backing store to the decoded raw buffer
      // Note: Buffer is a Uint8Array subclass; ensure length matches (width*height*channels)
      const expected = width * height * channels;
      if (data.length !== expected) {
        // Fallback to safe copy if sizes mismatch unexpectedly
        const dest = this.pixelMatrix.pixels;
        dest.set(data.subarray(0, Math.min(expected, data.length)));
      } else {
        this.pixelMatrix.pixels = new Uint8Array(
          data.buffer,
          data.byteOffset,
          data.length,
        );
      }
    } else {
      // Worker pool just to copy pixels (row-batched IPC)
      const cores = Math.min(os.cpus().length, height);
      const tasks = [];
      const ROW_BATCH = Math.max(
        1,
        parseInt(process.env.PIXEL_COPY_ROW_BATCH || '32', 10),
      );
      let nextRowStart = 0; // assign contiguous row blocks

      for (let k = 0; k < cores; k++) {
        tasks.push(
          new Promise((resolve, reject) => {
            const w = new Worker(new URL(import.meta.url), {
              workerData: {
                data: Buffer.from(data), // pass a copy for thread‑safety
                width,
                height,
                channels,
                rowsPerBatch: ROW_BATCH,
              },
            });

            w.on('message', (m) => {
              if (m.type === 'requestRowBlock') {
                if (nextRowStart >= height) {
                  w.postMessage({ type: 'noRowsLeft' });
                  return;
                }
                const y0 = nextRowStart;
                const count = Math.min(ROW_BATCH, height - nextRowStart);
                nextRowStart += count;
                w.postMessage({ type: 'rowBlockAssignment', y0, count });
              } else if (m.type === 'rowBlock') {
                const { y0, data: block } = m;
                // fast copy into backing array
                const dest = this.pixelMatrix.pixels; // Uint8Array
                const offset = y0 * width * channels;
                dest.set(block, offset);
              }
            });

            w.once('error', reject);
            w.once('exit', (code) =>
              code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
            );
          }),
        );
      }

      await Promise.all(tasks);
    }
    if (timer) timer.mark('pixelCopy');
    this.emitProcessingParams();
    this.autoCreateRelationships();
    if (timer) timer.mark('relations');
    logger.info(`── ImageProcessor ✔ finished (${this.imageName})`);
  }
}

/* ════════════════════ worker‑thread code ════════════════════ */

if (!isMainThread) {
  const { data, width, height: _height, channels } = workerData;
  const px = new Uint8ClampedArray(data.buffer);

  const send = (obj) => parentPort.postMessage(obj);
  send({ type: 'requestRowBlock' });

  parentPort.on('message', (msg) => {
    if (msg.type === 'rowBlockAssignment') {
      const y0 = msg.y0 | 0;
      const count = msg.count | 0;
      const rowStride = width * channels;
      const out = new Uint8Array(rowStride * count);
      // pack rows into one buffer
      for (let dy = 0; dy < count; dy++) {
        const y = y0 + dy;
        const srcOff = y * rowStride;
        const dstOff = dy * rowStride;
        for (let i = 0; i < rowStride; i++) out[dstOff + i] = px[srcOff + i];
      }
      send({ type: 'rowBlock', y0, count, data: out });
      send({ type: 'requestRowBlock' });
    } else if (msg.type === 'noRowsLeft') {
      process.exit(0);
    }
  });
}

ImageProcessor.prototype.autoCreateRelationships = function () {
  linkSpatial(
    this.regionManager.regions,
    this.options,
    this.metadataIndex,
    OntologyExt,
  );
};

ImageProcessor.prototype.emitProcessingParams = function () {
  try {
    const run = `urn:processing:single:${Date.now()}`;
    const params = {
      mergeRegions: this.options.mergeRegions,
      mergeIoUThreshold: this.options.mergeIoUThreshold,
      minSegmentationConfidence: this.options.minSegmentationConfidence,
      spatialRelationships: this.options.spatialRelationships,
      nearDistance: this.options.nearDistance,
      maxNearPairs: this.options.maxNearPairs,
      containsEnabled: this.options.containsEnabled,
      nearEnabled: this.options.nearEnabled,
      minRegionAreaForNear: this.options.minRegionAreaForNear,
      regionCount: this.regionManager.regions.length,
    };
    const lines = [
      '@prefix ex: <http://example.org/> .',
      '@prefix xsd:<http://www.w3.org/2001/XMLSchema#> .',
      `<${run}> a ex:ProcessingRun .`,
    ];
    Object.entries(params).forEach(([k, v]) => {
      lines.push(
        `<${run}> ex:processingParam [ ex:key "${k}" ; ex:value "${v}" ] .`,
      );
    });
    this.metadataIndex.insertQuads(lines.join('\n'));
  } catch (e) {
    import('../common/logger.js').then(({ logger }) =>
      logger.error('emitProcessingParams(single) failed', e),
    );
  }
};

export default ImageProcessor;
