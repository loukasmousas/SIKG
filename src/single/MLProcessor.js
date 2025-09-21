// MLProcessor.js
//
// Purpose: Load and run TF.js models (COCO‑SSD, DeepLab ADE20K, MediaPipe Face Detection)
// in Node. Uses promise caches to avoid repeated loads. Normalizes outputs to a uniform
// shape ({label, confidence, boundary}).

import * as tf from '@tensorflow/tfjs-node';
import '@tensorflow/tfjs-backend-cpu';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import * as deeplab from '@tensorflow-models/deeplab';
import * as faceDetection from '@tensorflow-models/face-detection';
import { logger } from '../common/logger.js';

// ── PROMISE caches (one load per process) ──────────────────────
let cocoPromise = null; // will hold a Promise
let deeplabPromise = null;
let faceDetPromise = null;

function getCoco() {
  // Similar usage: TFJS COCO-SSD model load
  // https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd#readme
  return (cocoPromise ??= cocoSsd.load({ base: 'lite_mobilenet_v2' }));
}

function getDeeplab() {
  // Similar usage: TFJS DeepLab (ADE20K) segmentation
  // https://github.com/tensorflow/tfjs-models/tree/master/deeplab#readme
  return (deeplabPromise ??= deeplab.load({
    base: 'ade20k',
    quantizationBytes: 2,
  }));
}

function getFaceDetector() {
  // MediaPipe Face Detector via TFJS runtime
  // https://github.com/tensorflow/tfjs-models/tree/master/face-detection
  const model = faceDetection.SupportedModels.MediaPipeFaceDetector;
  const cfg = { runtime: 'tfjs', maxFaces: 50 };
  return (faceDetPromise ??= faceDetection.createDetector(model, cfg));
}

/**
 * MLProcessor
 * Manages loading and running multiple TF.js models in Node:
 *  - COCO-SSD for object detection
 *  - DeepLab (ADE20K) for semantic segmentation
 */
class MLProcessor {
  constructor() {
    this.cocoModel = null;
    this.deeplabModel = null;
    this.faceDetector = null;
  }

  /**
   * Loads the COCO-SSD model (object detection).
   */
  async loadCocoModel() {
    this.cocoModel = await getCoco();
  }

  /**
   * Loads the DeepLab model with ADE20K for semantic segmentation.
   */
  async loadDeepLabModel() {
    this.deeplabModel = await getDeeplab();
  }

  /** Loads the MediaPipe Face Detector (face detection). */
  async loadFaceDetectorModel() {
    this.faceDetector = await getFaceDetector();
  }

  /**
   * Runs all loaded models on the given image buffer.
   * Returns an object with:
   *   - `detections`: bounding boxes from COCO-SSD
   *   - `deeplabSegmentation`: semantic segmentation from DeepLab
   *
   * @param {Buffer} imageBuffer - Encoded image (PNG/JPEG)
   * @returns {Object} { detections: [...], deeplabSegmentation: {...} }
   */
  async detectRegions(imageBuffer) {
    // Convert buffer to a 3-channel tensor
    const imageTensor = tf.node.decodeImage(imageBuffer, 3);

    // Gather results in this object
    const results = {
      detections: [],
      deeplabSegmentation: null,
      faces: [],
    };

    try {
      if (this.cocoModel) {
        logger.info('Running COCO-SSD inference...');
        const predictions = await this.cocoModel.detect(imageTensor);
        // Convert to a uniform format
        const detectionArr = predictions.map((det) => ({
          label: det.class,
          confidence: det.score,
          boundary: {
            x1: det.bbox[0],
            y1: det.bbox[1],
            x2: det.bbox[0] + det.bbox[2],
            y2: det.bbox[1] + det.bbox[3],
          },
        }));
        results.detections = detectionArr;
      }

      if (this.deeplabModel) {
        logger.info('Running DeepLab inference...');
        const segResult = await this.deeplabModel.segment(imageTensor);
        // segResult includes: legend, segmentationMap, width, height
        results.deeplabSegmentation = segResult;
      }

      if (this.faceDetector) {
        logger.info('Running face-detection inference...');
        // Ensure kernels required by face-detection are available: switch to CPU backend for this step
        const prev = tf.getBackend();
        let cpuTensor = null;
        let faces = [];
        try {
          if (prev !== 'cpu') await tf.setBackend('cpu');
          const [h, w] = [imageTensor.shape[0], imageTensor.shape[1]];
          const data = imageTensor.dataSync();
          cpuTensor = tf.tensor3d(data, [h, w, 3], 'int32');
          faces = await this.faceDetector.estimateFaces(cpuTensor);
        } finally {
          cpuTensor?.dispose?.();
          if (tf.getBackend() !== prev) await tf.setBackend(prev);
        }
        // Normalise to bbox format
        results.faces = (faces || []).map((f) => {
          const b = f.box || f.boundingBox || {};
          let x1, y1, x2, y2;
          if (
            b &&
            (b.xMin !== undefined || b.xmin !== undefined) &&
            (b.yMin !== undefined || b.ymin !== undefined) &&
            (b.xMax !== undefined || b.xmax !== undefined) &&
            (b.yMax !== undefined || b.ymax !== undefined)
          ) {
            x1 = b.xMin ?? b.xmin;
            y1 = b.yMin ?? b.ymin;
            x2 = b.xMax ?? b.xmax;
            y2 = b.yMax ?? b.ymax;
          } else if (b && b.topLeft && b.bottomRight) {
            x1 = b.topLeft[0];
            y1 = b.topLeft[1];
            x2 = b.bottomRight[0];
            y2 = b.bottomRight[1];
          } else if (b && b.left !== undefined) {
            x1 = b.left;
            y1 = b.top;
            x2 = b.left + (b.width ?? 0);
            y2 = b.top + (b.height ?? 0);
          } else if (f.topLeft && f.bottomRight) {
            x1 = f.topLeft[0];
            y1 = f.topLeft[1];
            x2 = f.bottomRight[0];
            y2 = f.bottomRight[1];
          } else {
            x1 = x2 = y1 = y2 = 0;
          }
          return {
            label: 'face',
            confidence:
              f.score ??
              f.scores?.[0] ??
              f.probability?.[0] ??
              f.probability ??
              1,
            boundary: { x1, y1, x2, y2 },
          };
        });
      }
    } catch (err) {
      logger.error('Error during region detection:', err);
      throw err;
    } finally {
      // Free the tensor
      imageTensor.dispose();
    }

    return results;
  }
}

export default MLProcessor;
