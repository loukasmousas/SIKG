// spatial-links.js
//
// Purpose: Derive spatial relationships between region pairs using deterministic,
// geometry-based predicates (near, contains, overlaps, inside, intersectsEdge).
// Thresholds are configurable and shared with evaluation to ensure parity.
//
// References
// - IoU (Jaccard index): https://en.wikipedia.org/wiki/Jaccard_index
// - Axis-aligned rectangle containment/overlap heuristics are standard in CV tooling;
//   the implementation follows straightforward AABB arithmetic.

export function autoCreateRelationships(
  regions,
  options,
  metadataIndex,
  OntologyExt,
) {
  if (!options || options.spatialRelationships === false) return;
  const regs = regions || [];
  const useNear = options.nearEnabled !== false;
  const useContains = options.containsEnabled !== false;
  const useOverlaps = options.overlapsEnabled !== false;
  const useEdge = options.edgeTouchEnabled !== false;
  const useInsideR = options.insideRatioEnabled !== false;
  const D = options.nearDistance ?? 100;
  const maxNear = options.maxNearPairs ?? 1000;
  const minAreaNear = options.minRegionAreaForNear ?? 25;
  const minOverlapIoU = options.minOverlapIoU ?? 0.05;
  const minOverlapArea = options.minOverlapArea ?? 50;
  const minInsideRatio = options.minInsideRatio ?? 0.9;
  const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);
  const ctr = (b) => [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2];
  const dist = (a, b) => {
    const [ax, ay] = ctr(a),
      [bx, by] = ctr(b);
    return Math.hypot(ax - bx, ay - by);
  };
  const contains = (A, B) =>
    A.x1 <= B.x1 && A.y1 <= B.y1 && A.x2 >= B.x2 && A.y2 >= B.y2;
  const interArea = (A, B) => {
    const x1 = Math.max(A.x1, B.x1),
      y1 = Math.max(A.y1, B.y1),
      x2 = Math.min(A.x2, B.x2),
      y2 = Math.min(A.y2, B.y2);
    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
  };
  const unionArea = (A, B) => area(A) + area(B) - interArea(A, B);
  const iou = (A, B) => {
    const ia = interArea(A, B);
    if (!ia) return 0;
    return ia / unionArea(A, B);
  };
  let nearCount = 0;
  for (let i = 0; i < regs.length; i++) {
    const A = regs[i];
    const uriA = A?.metadata?.uri;
    if (!uriA) continue;
    const areaA = area(A.boundary);
    for (let j = i + 1; j < regs.length; j++) {
      const B = regs[j];
      const uriB = B?.metadata?.uri;
      if (!uriB) continue;
      const areaB = area(B.boundary);
      if (
        useNear &&
        nearCount < maxNear &&
        areaA >= minAreaNear &&
        areaB >= minAreaNear
      ) {
        if (dist(A.boundary, B.boundary) < D) {
          OntologyExt.insertNearRelationship(metadataIndex, uriA, uriB);
          OntologyExt.insertNearRelationship(metadataIndex, uriB, uriA);
          nearCount++;
        }
      }
      if (useOverlaps) {
        const ia = interArea(A.boundary, B.boundary);
        if (ia >= minOverlapArea) {
          const isContain =
            contains(A.boundary, B.boundary) ||
            contains(B.boundary, A.boundary);
          if (!isContain) {
            const ovIoU = iou(A.boundary, B.boundary);
            if (ovIoU >= minOverlapIoU) {
              OntologyExt.insertOverlaps(metadataIndex, uriA, uriB);
              OntologyExt.insertOverlaps(metadataIndex, uriB, uriA);
            } else if (useEdge && ovIoU === 0 && ia > 0) {
              OntologyExt.insertIntersectsEdge(metadataIndex, uriA, uriB);
              OntologyExt.insertIntersectsEdge(metadataIndex, uriB, uriA);
            }
          }
        }
      }
      if (useInsideR) {
        const ia = interArea(A.boundary, B.boundary);
        if (ia) {
          if (contains(A.boundary, B.boundary)) {
            const ratio = ia / area(A.boundary);
            if (ratio >= minInsideRatio) {
              OntologyExt.insertInsideWithRatio(
                metadataIndex,
                uriA,
                uriB,
                ratio.toFixed(3),
              );
            }
          } else if (contains(B.boundary, A.boundary)) {
            const ratio = ia / area(B.boundary);
            if (ratio >= minInsideRatio) {
              OntologyExt.insertInsideWithRatio(
                metadataIndex,
                uriB,
                uriA,
                ratio.toFixed(3),
              );
            }
          }
        }
      }
      if (useContains) {
        if (contains(A.boundary, B.boundary))
          OntologyExt.insertContainsRelationship(metadataIndex, uriA, uriB);
        if (contains(B.boundary, A.boundary))
          OntologyExt.insertContainsRelationship(metadataIndex, uriB, uriA);
      }
    }
  }
}

// Pure computation variant used for evaluation (no side effects, returns array)
export function computeRelationsPure(regions, opts = {}) {
  // Option names intentionally match evaluator gold.options schema:
  //  - nearDistance, maxNearPairs, minRegionAreaForNear
  //  - minOverlapIoU, minOverlapArea
  //  - minInsideRatio
  const options = {
    nearEnabled: true,
    containsEnabled: true,
    overlapsEnabled: true,
    edgeTouchEnabled: true,
    insideRatioEnabled: true,
    nearDistance: 100,
    maxNearPairs: 1000,
    minRegionAreaForNear: 25,
    minOverlapIoU: 0.05,
    minOverlapArea: 50,
    minInsideRatio: 0.9,
    ...opts,
  };
  const regs = regions || [];
  const out = [];
  const area = (b) => (b.x2 - b.x1) * (b.y2 - b.y1);
  const ctr = (b) => [(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2];
  const dist = (a, b) => {
    const [ax, ay] = ctr(a),
      [bx, by] = ctr(b);
    return Math.hypot(ax - bx, ay - by);
  };
  const contains = (A, B) =>
    A.x1 <= B.x1 && A.y1 <= B.y1 && A.x2 >= B.x2 && A.y2 >= B.y2;
  const interArea = (A, B) => {
    const x1 = Math.max(A.x1, B.x1),
      y1 = Math.max(A.y1, B.y1),
      x2 = Math.min(A.x2, B.x2),
      y2 = Math.min(A.y2, B.y2);
    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
  };
  const unionArea = (A, B) => area(A) + area(B) - interArea(A, B);
  const iou = (A, B) => {
    const ia = interArea(A, B);
    return ia ? ia / unionArea(A, B) : 0;
  };
  let nearCount = 0;
  for (let i = 0; i < regs.length; i++) {
    const A = regs[i];
    for (let j = i + 1; j < regs.length; j++) {
      const B = regs[j];
      if (
        options.nearEnabled &&
        nearCount < options.maxNearPairs &&
        area(A.boundary) >= options.minRegionAreaForNear &&
        area(B.boundary) >= options.minRegionAreaForNear
      ) {
        if (dist(A.boundary, B.boundary) < options.nearDistance) {
          out.push({ predicate: 'near', source: A.id, target: B.id });
          out.push({ predicate: 'near', source: B.id, target: A.id });
          nearCount++;
        }
      }
      const ia = interArea(A.boundary, B.boundary);
      if (options.overlapsEnabled && ia >= options.minOverlapArea) {
        const isContain =
          contains(A.boundary, B.boundary) || contains(B.boundary, A.boundary);
        if (!isContain) {
          const ovIoU = iou(A.boundary, B.boundary);
          if (ovIoU >= options.minOverlapIoU) {
            out.push({ predicate: 'overlaps', source: A.id, target: B.id });
            out.push({ predicate: 'overlaps', source: B.id, target: A.id });
          }
        }
      }
      if (options.insideRatioEnabled && ia) {
        if (contains(A.boundary, B.boundary)) {
          const ratio = ia / area(A.boundary);
          if (ratio >= options.minInsideRatio)
            out.push({
              predicate: 'inside',
              source: A.id,
              target: B.id,
              ratio: +ratio.toFixed(3),
            });
        } else if (contains(B.boundary, A.boundary)) {
          const ratio = ia / area(B.boundary);
          if (ratio >= options.minInsideRatio)
            out.push({
              predicate: 'inside',
              source: B.id,
              target: A.id,
              ratio: +ratio.toFixed(3),
            });
        }
      }
      if (options.containsEnabled) {
        if (contains(A.boundary, B.boundary))
          out.push({ predicate: 'contains', source: A.id, target: B.id });
        if (contains(B.boundary, A.boundary))
          out.push({ predicate: 'contains', source: B.id, target: A.id });
      }
    }
  }
  return out;
}

export default { autoCreateRelationships, computeRelationsPure };
