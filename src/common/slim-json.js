// slim-json.js
// Helper to slim duplicate geometry fields from metadataIndex.index when desired.
// Mutates the provided metadataIndexData object; returns count of removed properties.

export function slimMetadataIndex(metadataIndexData) {
  if (!metadataIndexData || !metadataIndexData.index) return 0;
  let removed = 0;
  for (const [, md] of Object.entries(metadataIndexData.index)) {
    if (md && typeof md === 'object') {
      if ('x' in md) {
        delete md.x;
        removed++;
      }
      if ('y' in md) {
        delete md.y;
        removed++;
      }
      if ('w' in md) {
        delete md.w;
        removed++;
      }
      if ('h' in md) {
        delete md.h;
        removed++;
      }
    }
  }
  return removed;
}

export default { slimMetadataIndex };
