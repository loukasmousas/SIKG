// TiledMLSerializer.js
//
// Purpose: Persist and restore tiled pipeline outputs. Writes one .pht file per tile
// and a single JSON manifest that references all tiles plus the MetadataIndex and RegionManager
// snapshots. Complementary to src/common/Serializer.js used by the single‑image pipeline.

import { promises as fs } from 'fs';
import path from 'path';
import PixelMatrix from '../common/PixelMatrix.js';
import MetadataIndex from '../common/MetadataIndex.js';
import RegionManager from '../common/RegionManager.js';
import { logger } from '../common/logger.js';
import { slimMetadataIndex } from '../common/slim-json.js';

class TiledMLSerializer {
  /**
   * Saves:
   *  1) Each tile as a .pht
   *  2) One .json containing the tileManifest + metadataIndex + regionManager
   *
   * @param {Array} tiles - from TiledMLProcessor.tiles => [{x, y, pixelMatrix}]
   * @param {MetadataIndex} metadataIndex
   * @param {RegionManager} regionManager
   * @param {string} basePath - e.g. "tiledImage.json"
   */
  /**
   * Save tiled output: write N `.pht` tiles, then a single JSON referencing them.
   * @param {Array<{x:number,y:number,pixelMatrix:import('../common/PixelMatrix.js').default}>} tiles
   * @param {MetadataIndex} metadataIndex
   * @param {RegionManager} regionManager
   * @param {string} basePath - JSON path to write
   */
  static async save(tiles, metadataIndex, regionManager, basePath) {
    const baseName = path.basename(basePath, '.json');
    const dirName = path.dirname(basePath);

    // Save each tile to .pht
    const tileManifest = [];
    let tileIndex = 0;
    for (const tile of tiles) {
      const tileName = `${baseName}_tile_${tileIndex}.pht`;
      const tilePath = path.join(dirName, tileName);

      const buffer = tile.pixelMatrix.toBinary();
      await fs.writeFile(tilePath, buffer);

      tileManifest.push({
        x: tile.x,
        y: tile.y,
        width: tile.pixelMatrix.width,
        height: tile.pixelMatrix.height,
        channels: tile.pixelMatrix.channels,
        phtFile: tileName,
      });

      tileIndex++;
    }

    // Convert metadataIndex + regionManager to JSON
    const metadataIndexData = await metadataIndex.toJSON();
    const regionManagerData = regionManager.toJSON();

    // Option slimming: remove duplicate geometry keys from metadataIndex.index
    const SLIM = /^(1|true|yes)$/i.test(process.env.PHT_SLIM_JSON || '');
    if (SLIM) {
      const removed = slimMetadataIndex(metadataIndexData);
      if (removed)
        logger.info(
          `[TiledMLSerializer] Slimming removed ${removed} geometry props from metadataIndex.index (Option A)`,
        );
    }

    // Combine into a single JSON object
    const data = {
      tileManifest,
      metadataIndex: metadataIndexData,
      regionManager: regionManagerData,
    };

    const jsonStr = JSON.stringify(data, null, 2);
    await fs.writeFile(basePath, jsonStr, 'utf-8');
    logger.info(
      `TiledMLSerializer: wrote ${tiles.length} tiles + metadata to ${basePath}`,
    );
  }

  /**
   * Loads tiles + metadata from a single JSON + multiple .pht files
   *
   * @param {string} basePath - e.g. "tiledImage.json"
   * @returns {Promise<{ tiles, metadataIndex, regionManager }>}
   *   tiles => array of { x, y, pixelMatrix }
   */
  /**
   * Load tiled output: read JSON, reconstruct PixelMatrix tiles from `.pht` files,
   * and rehydrate MetadataIndex and RegionManager.
   * @param {string} basePath
   * @returns {Promise<{ tiles: Array<{x:number,y:number,pixelMatrix:PixelMatrix}>, metadataIndex: MetadataIndex, regionManager: RegionManager }>}
   */
  static async load(basePath) {
    const dirName = path.dirname(basePath);
    const jsonStr = await fs.readFile(basePath, 'utf-8');
    const data = JSON.parse(jsonStr);

    const tileManifest = data.tileManifest || [];

    // Reconstruct tiles
    const tiles = [];
    for (const info of tileManifest) {
      const tilePath = path.join(dirName, info.phtFile);
      const buffer = await fs.readFile(tilePath);
      const pm = PixelMatrix.fromBinary(
        info.width,
        info.height,
        info.channels,
        buffer,
      );

      tiles.push({
        x: info.x,
        y: info.y,
        pixelMatrix: pm,
      });
    }

    // Reconstruct metadataIndex
    const metadataIndex = await MetadataIndex.fromJSON(data.metadataIndex);

    // Reconstruct regionManager
    const regionManager = RegionManager.fromJSON(data.regionManager);

    logger.info(
      `TiledMLSerializer: Loaded ${tiles.length} tile(s) + metadata from ${basePath}`,
    );
    return { tiles, metadataIndex, regionManager };
  }
}

export default TiledMLSerializer;
