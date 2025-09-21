// GlobalRegistry.js
//
// Purpose: Load multiple manifests (single or tiled), merge RDF stores and region
// lists into a single in‑memory registry for cross‑image operations (clusters, queries).

import MetadataIndex from '../common/MetadataIndex.js';
import RegionManager from '../common/RegionManager.js';
import Serializer from '../common/Serializer.js';
import TiledMLSerializer from '../tiled/TiledMLSerializer.js';
import { promises as fs } from 'fs';
import { logger } from '../common/logger.js';

class GlobalRegistry {
  constructor() {
    this.metadataIndex = new MetadataIndex();
    this.regionManager = new RegionManager();
    this.sources = []; // e.g. { path, tiles, metadataIndex, regionManager }
  }

  /**
   * Auto-detect if the JSON is tiled or single-file, then load & merge.
   */
  async loadSource(jsonFilePath) {
    let rawData;
    {
      const raw = await fs.readFile(jsonFilePath, 'utf-8');
      rawData = JSON.parse(raw);
    }
    let isTiled = !!rawData.tileManifest;

    let tiles = [];
    let pixelMatrix = null;
    let metadataIndex;
    let regionManager;

    if (isTiled) {
      const {
        tiles: t,
        metadataIndex: mi,
        regionManager: rm,
      } = await TiledMLSerializer.load(jsonFilePath);
      tiles = t;
      metadataIndex = mi;
      regionManager = rm;
    } else {
      // single-file approach
      const ser = new Serializer(null, null, null);
      const result = await ser.load(jsonFilePath);
      metadataIndex = result.metadataIndex;
      regionManager = result.regionManager;
      pixelMatrix = result.pixelMatrix || null;
    }

    // Merge into global
    for (const [hashKey, md] of Object.entries(metadataIndex.index)) {
      this.metadataIndex.index[hashKey] = md;
    }
    const quads = metadataIndex.store.getQuads(null, null, null, null);
    quads.forEach((q) => this.metadataIndex.store.addQuad(q));

    regionManager.regions.forEach((r) => {
      this.regionManager.defineRegion(r.boundary, r.tags, r.metadata);
    });

    this.sources.push({
      path: jsonFilePath,
      tiles,
      pixelMatrix,
      metadataIndex,
      regionManager,
    });

    logger.info(
      `GlobalRegistry: Merged data from ${jsonFilePath} (tiled=${isTiled}).`,
    );
  }
}

export default GlobalRegistry;
