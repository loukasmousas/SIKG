// Serializer.js
//
// Purpose: Persist and restore the runtime state (PixelMatrix, MetadataIndex, RegionManager)
// to a deterministic JSON manifest plus a binary pixel file (.pht). The manifest includes
// minimal pixel metadata and references the .pht by name. This class is intentionally simple
// and side‑effect free beyond filesystem writes/reads.
//
// References
// - Node.js fs/promises writeFile/readFile: https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options
// - TypedArray basics (used by PixelMatrix binary conversions):
//   https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/TypedArray

import { promises as fs } from 'fs';
import path from 'path';
import PixelMatrix from './PixelMatrix.js';
import MetadataIndex from './MetadataIndex.js';
import RegionManager from './RegionManager.js';
import { logger } from './logger.js';
import { slimMetadataIndex } from './slim-json.js';

/**
 * Serializer
 *
 * Saves and loads manifests (.json) and pixel data (.pht) produced by the pipelines.
 * The .json contains:
 *  - metadataIndex JSON snapshot (including RDF Turtle text and relationship meta)
 *  - regionManager JSON (canonical region list with geometry + tags)
 *  - minimal pixelMatrix metadata referencing the .pht
 */
class Serializer {
  /**
   * Constructor
   * @param {PixelMatrix} pixelMatrix
   * @param {MetadataIndex} metadataIndex
   * @param {RegionManager} regionManager
   */
  /**
   * @param {PixelMatrix} pixelMatrix - in‑memory pixels (may be null for headless operations)
   * @param {MetadataIndex} metadataIndex - RDF store + hash index
   * @param {RegionManager} regionManager - canonical regions
   */
  constructor(pixelMatrix, metadataIndex, regionManager) {
    this.pixelMatrix = pixelMatrix;
    this.metadataIndex = metadataIndex;
    this.regionManager = regionManager;
  }

  /**
   * Saves data to:
   *  1) [filename].json   (contains metadataIndex, regionManager, and minimal pixel info)
   *  2) [filename].pht    (contains raw pixel data)
   *
   * e.g., if `savePath` is "imageData.json":
   *    - writes "imageData.json"
   *    - writes "imageData.pht"
   */
  /**
   * Save a manifest (.json) and pixel data (.pht) to disk.
   * @param {string} savePath - path to the JSON manifest to write
   */
  async save(savePath) {
    // Derive the .pht file name from the savePath
    const baseName = path.basename(savePath, '.json');
    // e.g. "imageData" if savePath is "imageData.json"

    const dirName = path.dirname(savePath);
    const phtFileName = `${baseName}.pht`; // e.g. "imageData.pht"
    const phtFilePath = path.join(dirName, phtFileName);

    // Write pixel data as binary .pht
    // Similar approach: writing Buffers with fs.writeFile
    // https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options
    if (this.pixelMatrix) {
      const pixelData = this.pixelMatrix.toBinary(); // returns Buffer
      await fs.writeFile(phtFilePath, pixelData);
    }

    // Convert MetadataIndex to JSON
    const metadataIndexData = await this.metadataIndex.toJSON();
    // Option slimming: drop duplicate geometry (x,y,w,h) kept in RegionManager + RDF
    const SLIM = /^(1|true|yes)$/i.test(process.env.PHT_SLIM_JSON || '');
    if (SLIM) {
      const removed = slimMetadataIndex(metadataIndexData);
      if (removed)
        logger.info(
          `[Serializer] Slimming removed ${removed} geometry props from metadataIndex.index (Option A)`,
        );
    }

    // Convert RegionManager to JSON
    const regionManagerData = this.regionManager.toJSON();

    // Minimal pixelMatrix info in JSON referencing the .pht
    const pixelMatrixInfo = {
      width: this.pixelMatrix ? this.pixelMatrix.width : 0,
      height: this.pixelMatrix ? this.pixelMatrix.height : 0,
      channels: this.pixelMatrix ? this.pixelMatrix.channels : 0,
      phtFile: phtFileName, // The .pht file containing raw pixels
    };

    // Combine into final JSON object
    const data = {
      pixelMatrix: pixelMatrixInfo,
      metadataIndex: metadataIndexData,
      regionManager: regionManagerData,
    };

    // Write JSON to [filename].json
    const jsonString = JSON.stringify(data, null, 2);
    await fs.writeFile(savePath, jsonString, 'utf-8');
  }

  /**
   * Loads data from:
   *   1) [filename].json  (metadata + references to .pht)
   *   2) [filename].pht   (binary pixel data)
   *
   * e.g., if `loadPath` = "imageData.json", we read "imageData.json" + "imageData.pht".
   */
  /**
   * Load a manifest (.json) and pixel data (.pht) from disk.
   * @param {string} loadPath - path to the JSON manifest to read
   * @returns {Promise<{ pixelMatrix: PixelMatrix|null, metadataIndex: MetadataIndex, regionManager: RegionManager }>}
   */
  async load(loadPath) {
    // Parse the JSON metadata
    const fileContent = await fs.readFile(loadPath, 'utf-8');
    const data = JSON.parse(fileContent);

    // Reconstruct MetadataIndex
    const metadataIndex = await MetadataIndex.fromJSON(data.metadataIndex);

    // Reconstruct RegionManager
    const regionManager = RegionManager.fromJSON(data.regionManager);

    // Reconstruct PixelMatrix from the .pht
    let pixelMatrix = null;
    if (data.pixelMatrix && data.pixelMatrix.phtFile) {
      const dirName = path.dirname(loadPath);
      const phtFilePath = path.join(dirName, data.pixelMatrix.phtFile);

      const width = data.pixelMatrix.width;
      const height = data.pixelMatrix.height;
      const channels = data.pixelMatrix.channels;

      // Read the .pht binary
      // Similar approach: reconstructing typed arrays from Buffer
      // https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/TypedArray
      const buffer = await fs.readFile(phtFilePath);
      pixelMatrix = PixelMatrix.fromBinary(width, height, channels, buffer);
    }

    return { pixelMatrix, metadataIndex, regionManager };
  }
}

export default Serializer;
