// TiledMLProcessor.js
//
// Purpose: Tile‑based processing for very large images. Generates PixelMatrix tiles,
// runs detections/segmentations per tile, transforms coordinates to global space,
// merges overlapping regions by IoU, and records merge provenance.
//
// Tile-based COCO-SSD + DeepLab pipeline that stores **exactly** the same
// region‑metadata schema as ImageProcessor.  DeepLab classes are persisted
// only when tile coverage >= minSegmentationConfidence (default 70%).
//
// Key tweaks
// ------------------------------------------------------------------
// -  Zero-copy -> tensors are built directly from the tile's Uint8Array
//    (no Array.from()).
// -  Default minSegmentationConfidence raised to 0.7 to match the
//    single-image pipeline.
// -  Comments & logging tidied.
// ------------------------------------------------------------------

import sharp from 'sharp';
import * as tf from '@tensorflow/tfjs-node';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import * as deeplab from '@tensorflow-models/deeplab';
import * as faceDetection from '@tensorflow-models/face-detection';
import '@tensorflow/tfjs-backend-cpu';

// module level PROMISE caches so multiple processors share model instances
let cocoPromise = null;
let deeplabPromise = null;
let faceDetPromise = null;

function getCoco() {
  return (cocoPromise ??= cocoSsd.load({ base: 'lite_mobilenet_v2' }));
}
function getDeeplab() {
  return (deeplabPromise ??= deeplab.load({
    base: 'ade20k',
    quantizationBytes: 2,
  }));
}
function getFaceDetector() {
  const model = faceDetection.SupportedModels.MediaPipeFaceDetector;
  const cfg = { runtime: 'tfjs', maxFaces: 50 };
  return (faceDetPromise ??= faceDetection.createDetector(model, cfg));
}

import PixelMatrix from '../common/PixelMatrix.js';
import MetadataIndex from '../common/MetadataIndex.js';
import RegionManager from '../common/RegionManager.js';
import OntologyExt from '../common/OntologyExtensions.js';
import ADE20K_LABELS from '../../models/ade20k_labels.js';
import { autoCreateRelationships as linkSpatial } from '../common/spatial-links.js';

class TiledMLProcessor {
  /**
   * @param {Buffer} imageBuffer
   * @param {Object} [options]
   *        tileSize                  - integer, default 512
   *        mergeRegions              - boolean, default true
   *        iouThreshold              - number,  default 0.5
   *        minSegmentationConfidence - number,  default 0.7 (70%)
   *        halo                      - static halo (px) when haloMode==='static'
   *        haloMode                  – 'static' | 'fraction' | 'auto'
   *        haloFraction              - fraction of tileSize for dynamic halo modes (default 0.1)
   *        cocoScoreThreshold        - minimum detection score for COCO boxes (default 0.5)
   *        cocoClassThresholds       - per-class thresholds { localName: score }
   *        maxTiles                  - safety cap on number of tiles (optional)
   *        nearDistance              - px distance for "near" relationship (default 100)
   *        tileStride                - override stride between tile keep areas (default computed = tileSize - 2*halo)
   *        adaptiveStride            - enable adaptive refinement pass (default false)
   *        densityThreshold          - avg regions/tile triggering refinement (default 5)
   *        strideReductionFactor     - factor to multiply stride for refinement (default 0.5)
   *        maxAdaptiveRounds         - max refinement passes (default 1)
   */
  constructor(imageBuffer, options = {}) {
    this.imageBuffer = imageBuffer;
    this.options = {
      tileSize: 640,
      halo: 64, // base overlap (px) if haloMode==='static'
      haloMode: 'static', // 'static' | 'fraction' | 'auto'
      haloFraction: 0.1, // 10% fraction when haloMode!='static'
      mergeRegions: true,
      iouThreshold: 0.5,
      minSegmentationConfidence: 0.7,
      cocoScoreThreshold: 0.5,
      cocoClassThresholds: {},
      maxTiles: undefined,
      nearDistance: 100,
      spatialRelationships: true,
      nearEnabled: true,
      containsEnabled: true,
      maxNearPairs: 1000,
      minRegionAreaForNear: 25,
      tileStride: undefined,
      adaptiveStride: false,
      densityThreshold: 5,
      strideReductionFactor: 0.5,
      maxAdaptiveRounds: 1,
      facePrivacy: true,
      minFaceConfidence: 0.6,
      performanceProfile: 'balanced', // 'fast' | 'balanced' | 'quality'
      ...options,
    };

    /* keep the image identifier handy for ex:within triples */
    this.safeName = this.options.safeName || 'tiledImage';

    this.metadataIndex = new MetadataIndex();
    this.regionManager = new RegionManager();
    this.tiles = [];
    this._rawModel = {
      detections: [],
      deeplab: [],
      faces: [],
      scoreFiltered: [],
      centerFiltered: [],
    };
  }

  /* ─────────────────── Load both TF‑JS models ─────────────────── */

  async loadModels(timer) {
    this.coco = await getCoco();
    this.deeplab = await getDeeplab();
    this.faceDetector = await getFaceDetector();
    if (timer) timer.mark('loadModels');
  }

  /* ─────────────────── Split image into tiles ─────────────────── */

  async tileImage(timer) {
    // Similar raw pixel extraction: sharp raw() + toBuffer()
    // https://sharp.pixelplumbing.com/api-output#raw
    const { data, info } = await sharp(this.imageBuffer, { failOnError: false })
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const N = this.options.tileSize;
    let halo = Math.max(0, this.options.halo | 0);
    if (this.options.haloMode === 'fraction') {
      halo = Math.round(N * this.options.haloFraction);
    } else if (this.options.haloMode === 'auto') {
      // auto: modest fraction but at least 32px, capped so that keep area stays reasonable
      halo = Math.min(
        Math.round(N * this.options.haloFraction),
        Math.max(32, Math.round(N / 8)),
      );
    }
    if (halo >= N / 2) halo = Math.max(0, Math.floor(N / 2) - 1); // ensure positive step
    this.effectiveHalo = halo;

    let step = this.options.tileStride ?? N - 2 * halo;
    if (!Number.isFinite(step) || step <= 0)
      step = Math.max(1, Math.round(N / 2));
    this.initialStep = step;
    this.imageInfo = { width, height, channels };
    this._tilePosSet = new Set();
    this._rawImage = data; // keep raw for adaptive refinement

    const maxTiles = this.options.maxTiles;

    outerY: for (let yKeep = 0; yKeep < height; yKeep += step) {
      for (let xKeep = 0; xKeep < width; xKeep += step) {
        if (maxTiles && this.tiles.length >= maxTiles) break outerY;
        const keep = {
          x1: xKeep,
          y1: yKeep,
          x2: Math.min(xKeep + N, width),
          y2: Math.min(yKeep + N, height),
        };
        // extraction bounds incl halo
        const left = Math.max(0, keep.x1 - halo);
        const top = Math.max(0, keep.y1 - halo);
        const right = Math.min(width, keep.x2 + halo);
        const bottom = Math.min(height, keep.y2 + halo);
        const wExt = right - left;
        const hExt = bottom - top;

        const pm = new PixelMatrix(wExt, hExt, channels);
        // Fast row-wise copy path (much faster than per-pixel set)
        const FAST_TILING = /^(1|true|yes)$/i.test(
          String(process.env.PHT_FAST_TILING || '1'),
        );
        if (FAST_TILING && yKeep === 0 && xKeep === 0) {
          // log once for the first tile of the image
          (await import('../common/logger.js')).logger.info(
            '[tiled] Tiling: FAST row-wise copy active',
          );
        }
        if (FAST_TILING) {
          const rowStrideDst = wExt * channels;
          for (let y = 0; y < hExt; y++) {
            const srcY = top + y;
            const srcOff = (srcY * width + left) * channels;
            const dstOff = y * rowStrideDst;
            pm.pixels.set(data.subarray(srcOff, srcOff + rowStrideDst), dstOff);
          }
        } else {
          for (let y = 0; y < hExt; y++) {
            const srcY = top + y;
            for (let x = 0; x < wExt; x++) {
              const srcX = left + x;
              const s = (srcY * width + srcX) * channels;
              pm.setPixel(x, y, data[s], data[s + 1], data[s + 2], data[s + 3]);
            }
          }
        }
        this.tiles.push({ x: left, y: top, keep, pixelMatrix: pm });
        this._tilePosSet.add(`${keep.x1},${keep.y1}`);
      }
    }
    if (timer) timer.mark('tiling');
  }

  /* ─────────────────── Infer COCO & DL per tile ───────────────── */

  async detectForEachTile(tiles = this.tiles, timer) {
    const _COCO_URI = 'http://example.org/model#COCO_SSD'; // unused (future provenance)
    const _DL_URI = 'http://example.org/model#DeepLab'; // unused (future provenance)

    let tileIdx = 0;
    for (const tile of tiles) {
      /* build a tensor directly from the tile’s Uint8Array (zero‑copy) */
      const raw = tile.pixelMatrix.toBinary(); // Buffer ≡ Uint8Array
      const h = tile.pixelMatrix.height;
      const w = tile.pixelMatrix.width;
      const ch = tile.pixelMatrix.channels;
      let tensor = tf.tensor3d(raw, [h, w, ch], 'int32');

      if (ch === 4) {
        // drop alpha for DL/COCO
        tensor = tensor.slice([0, 0, 0], [h, w, 3]).toInt();
      }

      /* ───── COCO-SSD bounding boxes ───── */
      for (const det of await this.coco.detect(tensor)) {
        const [lx, ly, lw, lh] = det.bbox;
        const fullX1 = tile.x + lx;
        const fullY1 = tile.y + ly;
        const fullX2 = fullX1 + lw;
        const fullY2 = fullY1 + lh;
        const rawClass = det.class || det.label;
        const localLabel = MetadataIndex.safeLocalName(rawClass);
        const perClassThresh = this.options.cocoClassThresholds[localLabel];
        const thresh =
          perClassThresh != null
            ? perClassThresh
            : this.options.cocoScoreThreshold;
        if (det.score < thresh) {
          if (process.env.PHT_DEBUG_DISCARD)
            this._rawModel.scoreFiltered.push({
              class: rawClass,
              score: det.score,
            });
          continue;
        } // score filter
        // Filter by center inside keep area to suppress duplicates
        if (
          tile.keep &&
          ((fullX1 + fullX2) / 2 < tile.keep.x1 ||
            (fullX1 + fullX2) / 2 > tile.keep.x2 ||
            (fullY1 + fullY2) / 2 < tile.keep.y1 ||
            (fullY1 + fullY2) / 2 > tile.keep.y2)
        ) {
          if (process.env.PHT_DEBUG_DISCARD)
            this._rawModel.centerFiltered.push({
              class: rawClass,
              score: det.score,
            });
          continue;
        }
        const B = { x1: fullX1, y1: fullY1, x2: fullX2, y2: fullY2 };

        // sanitise the class label once
        const local = localLabel;

        const rid = this.regionManager.defineRegion(B, [local], {
          description: `Auto: ${det.class}`,
          confidence: det.score,
          model: 'coco-ssd',
          classLabel: local,
        });

        const uri = `uri://${this.safeName}/tiledImage/${rid}`; // unified scheme <image>/<pipeline>/<id>
        const bb = this.regionManager.regions[rid].boundary; // real bbox
        this.regionManager.regions[rid].metadata.uri = uri;

        /* flat JSON metadata (viewer + Serializer still use this) */
        this.metadataIndex.insert(
          'region',
          this.safeName,
          { regionId: rid },
          {
            description: `Auto: ${det.class}`,
            confidence: det.score,
            x: bb.x1,
            y: bb.y1,
            w: bb.x2 - bb.x1,
            h: bb.y2 - bb.y1,
            model: 'coco-ssd',
            classLabel: local,
          },
          'tiledImage',
        );

        /* Turtle quads for SPARQL – self-contained with prefixes */
        this.regionManager.regions[rid].provenance = { detectedBy: 'coco-ssd' };
        this.metadataIndex.insertQuads(`
          @prefix ex:  <http://example.org/> .
          @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

          <${uri}>  a             ex:${local} ;
                    ex:within     <urn:image:${this.safeName}> ;
                    ex:x          ${bb.x1} ;
                    ex:y          ${bb.y1} ;
                    ex:w          ${bb.x2 - bb.x1} ;
                    ex:h          ${bb.y2 - bb.y1} ;
                    ex:confidence ${det.score} ;
                    ex:detectedBy <http://example.org/model/coco-ssd> .
  `);
        this._rawModel.detections.push({
          class: local,
          score: det.score,
          x: bb.x1,
          y: bb.y1,
          w: bb.x2 - bb.x1,
          h: bb.y2 - bb.y1,
        });
      }

      /* ───── DeepLab semantic classes (optional based on performance) ───── */
      if (this.options.performanceProfile !== 'fast')
        try {
          const resized = tf.image.resizeBilinear(tensor, [513, 513]).toInt();
          const { legend, segmentationMap } =
            await this.deeplab.segment(resized);
          resized.dispose();

          const total = segmentationMap.length;
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
            const raw =
              entry.name || entry.label || ADE20K_LABELS[id] || `class-${id}`;
            const local = MetadataIndex.safeLocalName(raw);

            // Use keep area as canonical bounding region to align with de-dup logic
            const useKeep = tile.keep || {
              x1: tile.x,
              y1: tile.y,
              x2: tile.x + w,
              y2: tile.y + h,
            };
            const rid = this.regionManager.defineRegion(
              {
                x1: useKeep.x1,
                y1: useKeep.y1,
                x2: useKeep.x2,
                y2: useKeep.y2,
              },
              [local],
              {
                description: `DeepLab class: ${local}`,
                confidence: conf,
                classId: id,
                classLabel: local,
                model: 'deeplab',
              },
            );

            const uri = `uri://${this.safeName}/tiledImage/${rid}`; // unified scheme
            const bb = this.regionManager.regions[rid].boundary;
            this.regionManager.regions[rid].metadata.uri = uri;

            /* flat JSON metadata */
            this.metadataIndex.insert(
              'region',
              this.safeName,
              { regionId: rid },
              {
                description: `DeepLab class: ${local}`,
                confidence: conf,
                classId: id,
                classLabel: local,
                model: 'deeplab',
                x: bb.x1,
                y: bb.y1,
                w: bb.x2 - bb.x1,
                h: bb.y2 - bb.y1,
              },
              'tiledImage',
            );

            /* Turtle triples with prefixes */
            this.regionManager.regions[rid].provenance = {
              detectedBy: 'deeplab',
            };
            this.metadataIndex.insertQuads(`
            @prefix ex:  <http://example.org/> .
            @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

            <${uri}>  a             ex:${local} ;
                      ex:within     <urn:image:${this.safeName}> ;
                      ex:x          ${bb.x1} ;
                      ex:y          ${bb.y1} ;
                      ex:w          ${bb.x2 - bb.x1} ;
                      ex:h          ${bb.y2 - bb.y1} ;
                      ex:confidence ${conf} ;
                      ex:detectedBy <http://example.org/model/deeplab-ade20k> .
          `);
            this._rawModel.deeplab.push({ class: local, score: conf });
          });
        } catch (e) {
          import('../common/logger.js').then(({ logger }) =>
            logger.error(`DeepLab tile #${tileIdx} failed`, e),
          );
        }

      /* ───── Face Detection (privacy) ───── */
      if (this.options.facePrivacy !== false && this.faceDetector) {
        try {
          const prev = tf.getBackend();
          let cpuTensor = null;
          let faces = [];
          try {
            if (prev !== 'cpu') await tf.setBackend('cpu');
            const h = tensor.shape[0],
              w = tensor.shape[1];
            const data = tensor.dataSync();
            cpuTensor = tf.tensor3d(data, [h, w, 3], 'int32');
            faces = await this.faceDetector.estimateFaces(cpuTensor);
          } finally {
            cpuTensor?.dispose?.();
            if (tf.getBackend() !== prev) await tf.setBackend(prev);
          }
          for (const f of faces || []) {
            const prob =
              f.score ??
              f.scores?.[0] ??
              f.probability?.[0] ??
              f.probability ??
              1;
            if (prob < this.options.minFaceConfidence) continue;
            const b = f.box || f.boundingBox || {};
            let lx, ly, rx, by;
            if (
              (b.xMin !== undefined || b.xmin !== undefined) &&
              (b.yMin !== undefined || b.ymin !== undefined) &&
              (b.xMax !== undefined || b.xmax !== undefined) &&
              (b.yMax !== undefined || b.ymax !== undefined)
            ) {
              lx = b.xMin ?? b.xmin;
              ly = b.yMin ?? b.ymin;
              rx = b.xMax ?? b.xmax;
              by = b.yMax ?? b.ymax;
            } else if (b.topLeft && b.bottomRight) {
              lx = b.topLeft[0];
              ly = b.topLeft[1];
              rx = b.bottomRight[0];
              by = b.bottomRight[1];
            } else if (b.left !== undefined) {
              lx = b.left;
              ly = b.top;
              rx = b.left + (b.width ?? 0);
              by = b.top + (b.height ?? 0);
            } else if (f.topLeft && f.bottomRight) {
              lx = f.topLeft[0];
              ly = f.topLeft[1];
              rx = f.bottomRight[0];
              by = f.bottomRight[1];
            } else {
              continue;
            }
            const fullX1 = tile.x + lx;
            const fullY1 = tile.y + ly;
            const fullX2 = tile.x + rx;
            const fullY2 = tile.y + by;
            // Filter by centre in keep
            const cx = (fullX1 + fullX2) / 2;
            const cy = (fullY1 + fullY2) / 2;
            if (
              tile.keep &&
              (cx < tile.keep.x1 ||
                cx > tile.keep.x2 ||
                cy < tile.keep.y1 ||
                cy > tile.keep.y2)
            )
              continue;
            const B = { x1: fullX1, y1: fullY1, x2: fullX2, y2: fullY2 };
            const rid = this.regionManager.defineRegion(B, ['face'], {
              description: 'Auto: face',
              confidence: prob,
              model: 'face-detection',
              classLabel: 'face',
            });
            const uri = `uri://${this.safeName}/tiledImage/${rid}`;
            const bb = this.regionManager.regions[rid].boundary;
            this.regionManager.regions[rid].metadata.uri = uri;

            this.metadataIndex.insert(
              'region',
              this.safeName,
              { regionId: rid },
              {
                description: 'Auto: face',
                confidence: prob,
                x: bb.x1,
                y: bb.y1,
                w: bb.x2 - bb.x1,
                h: bb.y2 - bb.y1,
                model: 'face-detection',
                classLabel: 'face',
              },
              'tiledImage',
            );
            this.regionManager.regions[rid].provenance = {
              detectedBy: 'face-detection',
            };
            this.metadataIndex.insertQuads(`
              @prefix ex:  <http://example.org/> .
              @prefix md:  <http://example.org/metadata#> .
              <${uri}>  a             ex:face ;
                        ex:within     <urn:image:${this.safeName}> ;
                        ex:x          ${bb.x1} ;
                        ex:y          ${bb.y1} ;
                        ex:w          ${bb.x2 - bb.x1} ;
                        ex:h          ${bb.y2 - bb.y1} ;
                        ex:confidence ${prob} ;
                        md:detectedBy <http://example.org/model/face-detection> .
            `);
            const action = `urn:privacy:blur:${Date.now()}:${rid}`;
            this.metadataIndex.insertQuads(`
              @prefix md:  <http://example.org/metadata#> .
              <${action}> a md:PrivacyAction ; md:action "blur" ; md:target <${uri}> .
            `);
            this._rawModel.faces.push({
              confidence: prob,
              x: bb.x1,
              y: bb.y1,
              w: bb.x2 - bb.x1,
              h: bb.y2 - bb.y1,
            });
          }
        } catch (e) {
          import('../common/logger.js').then(({ logger }) =>
            logger.error(`Face-detection tile #${tileIdx} failed`, e),
          );
        }
      }

      tensor.dispose();
      tileIdx++;
    }
    if (timer) timer.mark('detectTiles');
  }

  /* ─────────────────── Pipeline driver ─────────────────── */

  async processImage(timer) {
    await this.loadModels(timer);
    await this.tileImage(timer);
    await this.detectForEachTile(this.tiles, timer);

    // Adaptive stride refinement (skip for fast profile)
    this.adaptiveRounds = 0;
    if (
      this.options.adaptiveStride &&
      this.options.performanceProfile !== 'fast'
    ) {
      while (this.adaptiveRounds < this.options.maxAdaptiveRounds) {
        const avgDensity =
          this.regionManager.regions.length / this.tiles.length;
        if (avgDensity <= this.options.densityThreshold) break;
        const added = this.refineAdaptiveTiling();
        if (!added.length) break;
        await this.detectForEachTile(added, timer);
        this.adaptiveRounds++;
      }
    }

    if (this.options.mergeRegions) {
      const preUriMap = new Map(
        this.regionManager.regions.map((r) => [r.id, r.metadata?.uri]),
      );
      const prov = this.regionManager.mergeOverlappingRegions(
        this.options.iouThreshold,
      );
      if (prov && prov.some((p) => p.sources.length > 1)) {
        const ts = Date.now();
        prov.forEach((p) => {
          if (p.sources.length <= 1) return;
          const target = this.regionManager.regions[p.target];
          if (!target.metadata) target.metadata = {};
          if (!target.metadata.uri)
            target.metadata.uri = `uri://${this.safeName}/tiledImage/${target.id}`; // unified scheme
          const eventNode = `urn:merge:tiled:${ts}:${p.target}`;
          this.metadataIndex.insertQuads(
            `@prefix ex:<http://example.org/> . <${eventNode}> a ex:MergeEvent .`,
          );
          p.sources.forEach((srcId) => {
            const srcUri =
              preUriMap.get(srcId) ||
              `uri://${this.safeName}/tiledImage/${srcId}`; // unified scheme
            this.metadataIndex.insertQuads(
              `@prefix ex:<http://example.org/> . <${target.metadata.uri}> ex:mergedFrom <${srcUri}> . <${srcUri}> ex:participatedInMerge <${eventNode}> .`,
            );
          });
        });
      }
      if (process.env.PHT_DEBUG_DISCARD) {
        try {
          const fs = await import('fs/promises');
          const debugDir = 'output/debug';
          await fs.mkdir(debugDir, { recursive: true });
          const payload = {
            image: this.safeName,
            rawDetections: this._rawModel.detections.length,
            finalRegions: this.regionManager.regions.length,
            scoreFiltered: this._rawModel.scoreFiltered,
            centerFiltered: this._rawModel.centerFiltered,
            mergedGroups: (prov || [])
              .filter((p) => p.sources.length > 1)
              .map((p) => ({ target: p.target, sources: p.sources })),
          };
          await fs.writeFile(
            `${debugDir}/discard-${this.safeName}.json`,
            JSON.stringify(payload, null, 2),
          );
        } catch (_e) {
          /* ignore debug errors */
        }
      }
    }

    this.emitProcessingParams();
    this.autoCreateRelationships();
    if (timer) timer.mark('relations');
  }

  refineAdaptiveTiling() {
    const { width, height, channels } = this.imageInfo || {};
    if (!width) return [];
    let newStep = Math.round(
      this.initialStep * this.options.strideReductionFactor,
    );
    if (!Number.isFinite(newStep) || newStep <= 0)
      newStep = Math.max(1, Math.floor(this.initialStep / 2));
    if (newStep >= this.initialStep)
      newStep = Math.max(1, Math.floor(this.initialStep / 2));
    const offset = Math.round(newStep / 2); // stagger grid
    const N = this.options.tileSize;
    const halo = this.effectiveHalo || 0;
    const maxTiles = this.options.maxTiles;
    const added = [];
    outer: for (let yKeep = offset; yKeep < height; yKeep += newStep) {
      for (let xKeep = offset; xKeep < width; xKeep += newStep) {
        if (maxTiles && this.tiles.length + added.length >= maxTiles)
          break outer;
        const keep = {
          x1: xKeep,
          y1: yKeep,
          x2: Math.min(xKeep + N, width),
          y2: Math.min(yKeep + N, height),
        };
        const key = `${keep.x1},${keep.y1}`;
        if (this._tilePosSet.has(key)) continue;
        const left = Math.max(0, keep.x1 - halo);
        const top = Math.max(0, keep.y1 - halo);
        const right = Math.min(width, keep.x2 + halo);
        const bottom = Math.min(height, keep.y2 + halo);
        const wExt = right - left;
        const hExt = bottom - top;
        const pm = new PixelMatrix(wExt, hExt, channels);
        const raw = this._rawImage;
        for (let y = 0; y < hExt; y++) {
          const srcY = top + y;
          for (let x = 0; x < wExt; x++) {
            const srcX = left + x;
            const s = (srcY * width + srcX) * channels;
            pm.setPixel(x, y, raw[s], raw[s + 1], raw[s + 2], raw[s + 3]);
          }
        }
        const tile = { x: left, y: top, keep, pixelMatrix: pm };
        this.tiles.push(tile);
        added.push(tile);
        this._tilePosSet.add(key);
      }
    }
    return added;
  }

  emitProcessingParams() {
    try {
      const run = `urn:processing:tiled:${Date.now()}`;
      const params = {
        tileSize: this.options.tileSize,
        haloMode: this.options.haloMode,
        halo: this.options.halo,
        effectiveHalo: this.effectiveHalo,
        haloFraction: this.options.haloFraction,
        initialStep: this.initialStep,
        adaptiveStride: this.options.adaptiveStride,
        adaptiveRounds: this.adaptiveRounds,
        densityThreshold: this.options.densityThreshold,
        strideReductionFactor: this.options.strideReductionFactor,
        cocoScoreThreshold: this.options.cocoScoreThreshold,
        perClassThreshCount: Object.keys(this.options.cocoClassThresholds || {})
          .length,
        minSegmentationConf: this.options.minSegmentationConfidence,
        mergeRegions: this.options.mergeRegions,
        iouThreshold: this.options.iouThreshold,
        nearDistance: this.options.nearDistance,
        spatialRelationships: this.options.spatialRelationships,
        nearEnabled: this.options.nearEnabled,
        containsEnabled: this.options.containsEnabled,
        maxNearPairs: this.options.maxNearPairs,
        minRegionAreaForNear: this.options.minRegionAreaForNear,
        maxTiles: this.options.maxTiles,
        totalTiles: this.tiles.length,
        totalRegions: this.regionManager.regions.length,
      };
      const lines = [
        '@prefix ex: <http://example.org/> .',
        '@prefix xsd:<http://www.w3.org/2001/XMLSchema#> .',
        `<${run}> a ex:ProcessingRun .`,
      ];
      Object.entries(params).forEach(([k, v]) => {
        if (v === undefined || v === null) return;
        lines.push(
          `<${run}> ex:processingParam [ ex:key "${k}" ; ex:value "${v}" ] .`,
        );
      });
      // Expand per-class thresholds explicitly
      Object.entries(this.options.cocoClassThresholds || {}).forEach(
        ([cls, thr]) => {
          lines.push(
            `<${run}> ex:processingParam [ ex:key "cocoClassThreshold" ; ex:class "${cls}" ; ex:value "${thr}" ] .`,
          );
        },
      );
      this.metadataIndex.insertQuads(lines.join('\n'));
    } catch (e) {
      import('../common/logger.js').then(({ logger }) =>
        logger.error('emitProcessingParams failed', e),
      );
    }
  }

  /* ─────────────────── Simple spatial links ─────────────── */

  autoCreateRelationships() {
    linkSpatial(
      this.regionManager.regions,
      this.options,
      this.metadataIndex,
      OntologyExt,
    );
  }
}

export default TiledMLProcessor;
