// extract-person-images.mjs (multi-crop person regions)
import fs from 'fs';
import path from 'path';
import Serializer from '../src/common/Serializer.js';
import sharp from 'sharp';

export async function extractPersonImages(manifestPath, outputDir) {
  try {
    const serializer = new Serializer();
    if (!manifestPath.endsWith('.json')) {
      console.warn(
        '[extract-person-images] Expected a .json manifest. If you passed a .pht file, pass the matching .json instead.',
      );
    }
    const { pixelMatrix, regionManager } = await serializer.load(manifestPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    const persons = regionManager.getRegionsByTag('person');
    if (!persons.length) {
      console.log('No person regions.');
      return;
    }
    for (const r of persons) {
      const { x1, y1, x2, y2 } = r.boundary;
      const left = Math.floor(Math.max(0, x1));
      const top = Math.floor(Math.max(0, y1));
      const width = Math.max(
        0,
        Math.min(pixelMatrix.width, Math.ceil(x2)) - left,
      );
      const height = Math.max(
        0,
        Math.min(pixelMatrix.height, Math.ceil(y2)) - top,
      );
      if (!width || !height) continue;
      const buf = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const p = pixelMatrix.getPixel(left + x, top + y);
          const i = (y * width + x) * 4;
          buf[i] = p.r;
          buf[i + 1] = p.g;
          buf[i + 2] = p.b;
          buf[i + 3] = p.a;
        }
      const outPath = path.join(outputDir, `person_region_${r.id}.png`);
      await sharp(buf, { raw: { width, height, channels: 4 } })
        .png()
        .toFile(outPath);
      console.log('Saved', outPath);
    }
  } catch (e) {
    console.error('extract-person-images failed:', e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest =
    process.argv[2] || path.join(process.cwd(), 'imageData.json');
  const out = process.argv[3] || path.join(process.cwd(), 'person_images');
  extractPersonImages(manifest, out).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
