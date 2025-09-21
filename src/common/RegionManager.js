// RegionManager.js
//
// Purpose: Maintain a canonical list of regions with stable IDs, boundaries, and tags.
// Provides simple spatial utilities and a merge routine for overlapping regions.
//
// Notes
// - The merge routine uses IoU (Intersection‑over‑Union) as the overlap criterion.
//   IoU is equivalent to the Jaccard index in set theory.
//   Background: https://en.wikipedia.org/wiki/Jaccard_index

/** RegionManager — holds canonical regions and utilities */
class RegionManager {
  constructor() {
    this.regions = []; // Array of region objects
  }

  /**
   * Defines a new region.
   * @param {Object} boundary - { x1, y1, x2, y2 }
   * @param {Array} tags - Array of tags (e.g., ['person'])
   * @param {Object} metadata - Additional metadata
   * @returns {Number} - The ID of the newly defined region
   */
  /**
   * Define a new region.
   * @param {{x1:number,y1:number,x2:number,y2:number}} boundary
   * @param {string[]} tags
   * @param {Object} metadata
   * @returns {number} id
   */
  defineRegion(boundary, tags, metadata) {
    const regionId = this.regions.length;
    this.regions.push({
      id: regionId,
      boundary,
      tags,
      metadata,
    });
    return regionId;
  }

  /**
   * Merges overlapping bounding boxes above a specified IoU threshold.
   * This modifies `this.regions` in place, unifying duplicates.
   * @param {Number} iouThreshold
   */
  /**
   * Merge regions with IoU > threshold. Returns provenance describing which
   * original IDs were merged into each survivor.
   * @param {number} iouThreshold
   * @returns {{target:number,sources:number[]}[]}
   */
  mergeOverlappingRegions(iouThreshold = 0.5) {
    const merged = [];
    const provenance = []; // array of { target:newIndex, sources:[oldIds] }
    const mappingTemp = new Map(); // temp map mergedIndex -> set of old ids

    for (let i = 0; i < this.regions.length; i++) {
      const current = this.regions[i];
      let mergedIndex = -1;
      for (let j = 0; j < merged.length; j++) {
        if (computeIoU(current.boundary, merged[j].boundary) > iouThreshold) {
          merged[j].boundary = mergeBoundaries(
            merged[j].boundary,
            current.boundary,
          );
          const combinedTags = new Set([...merged[j].tags, ...current.tags]);
          merged[j].tags = Array.from(combinedTags);
          // record provenance
          mappingTemp.get(j).add(current.id);
          mergedIndex = j;
          break;
        }
      }
      if (mergedIndex === -1) {
        merged.push(current);
        mappingTemp.set(merged.length - 1, new Set([current.id]));
      }
    }

    // Reassign IDs, attach provenance.mergedFrom for multi-source merges, and build provenance array
    this.regions = merged.map((r, idx) => {
      const sources = mappingTemp.get(idx)
        ? Array.from(mappingTemp.get(idx))
        : [r.id];
      const newRegion = { ...r, id: idx };
      if (sources.length > 1) {
        newRegion.provenance = newRegion.provenance || {};
        newRegion.provenance.mergedFrom = sources;
      }
      return newRegion;
    });
    for (const [mIdx, ids] of mappingTemp.entries()) {
      provenance.push({ target: mIdx, sources: Array.from(ids) });
    }
    return provenance;
  }

  /**
   * Retrieves regions containing a specific pixel.
   * @param {Number} x
   * @param {Number} y
   * @returns {Array} - Array of regions containing the pixel
   */
  /** Return all regions containing pixel (x,y). */
  getRegionsByPixel(x, y) {
    return this.regions.filter((region) => {
      return (
        x >= region.boundary.x1 &&
        x <= region.boundary.x2 &&
        y >= region.boundary.y1 &&
        y <= region.boundary.y2
      );
    });
  }

  /**
   * Retrieves regions by a specific tag.
   * @param {String} tag
   * @returns {Array} - Array of regions with the specified tag
   */
  /** Return all regions annotated with the given tag. */
  getRegionsByTag(tag) {
    return this.regions.filter((region) => region.tags.includes(tag));
  }

  /**
   * Serializes the RegionManager to JSON.
   * @returns {Object}
   */
  /** Serialize to a plain JSON object. */
  toJSON() {
    return { regions: this.regions };
  }

  /**
   * Deserializes JSON data to a RegionManager instance.
   * @param {Object} json
   * @returns {RegionManager}
   */
  /** Restore from a plain JSON object. */
  static fromJSON(json) {
    const instance = new RegionManager();
    instance.regions = json.regions || [];
    return instance;
  }
}

/** Helper functions for merging bounding boxes **/

function computeIoU(b1, b2) {
  const interArea = getIntersectionArea(b1, b2);
  const unionArea = getArea(b1) + getArea(b2) - interArea;
  // IoU background: Intersection-over-Union metric
  // https://en.wikipedia.org/wiki/Jaccard_index (a.k.a. IoU in vision)
  return unionArea === 0 ? 0 : interArea / unionArea;
}

function getIntersectionArea(b1, b2) {
  const xA = Math.max(b1.x1, b2.x1);
  const yA = Math.max(b1.y1, b2.y1);
  const xB = Math.min(b1.x2, b2.x2);
  const yB = Math.min(b1.y2, b2.y2);
  const width = Math.max(0, xB - xA);
  const height = Math.max(0, yB - yA);
  return width * height;
}

function getArea(b) {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);
}

function mergeBoundaries(b1, b2) {
  return {
    x1: Math.min(b1.x1, b2.x1),
    y1: Math.min(b1.y1, b2.y1),
    x2: Math.max(b1.x2, b2.x2),
    y2: Math.max(b1.y2, b2.y2),
  };
}

export default RegionManager;
