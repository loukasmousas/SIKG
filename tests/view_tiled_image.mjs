// view_tiled_image.mjs
import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import TiledMLSerializer from '../src/tiled/TiledMLSerializer.js';

async function main() {
  try {
    const jsonPath =
      process.argv[2] || path.join(process.cwd(), 'tiledImage.json');
    const { tiles, regionManager } = await TiledMLSerializer.load(jsonPath);
    if (!tiles || !tiles.length) {
      console.log('No tiles found.');
      return;
    }
    let maxX = 0,
      maxY = 0;
    for (const t of tiles) {
      const r = t.x + t.pixelMatrix.width;
      const b = t.y + t.pixelMatrix.height;
      if (r > maxX) maxX = r;
      if (b > maxY) maxY = b;
    }
    const channels = 4;
    const full = new Uint8Array(maxX * maxY * channels).fill(0);
    for (const tile of tiles) {
      const { width, height, channels: ch } = tile.pixelMatrix;
      const raw = tile.pixelMatrix.toBinary();
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const si = (y * width + x) * ch;
          const dx = tile.x + x;
          const dy = tile.y + y;
          const di = (dy * maxX + dx) * channels;
          full[di] = raw[si] || 0;
          full[di + 1] = raw[si + 1] || 0;
          full[di + 2] = raw[si + 2] || 0;
          full[di + 3] = ch === 4 ? raw[si + 3] : 255;
        }
    }
    const regions = regionManager.regions || [];
    const svgRects = regions
      .map((r) => {
        const { x1, y1, x2, y2 } = r.boundary;
        const w = x2 - x1;
        const h = y2 - y1;
        const color = r.tags.includes('person') ? 'red' : 'lime';
        return `<rect x="${x1}" y="${y1}" width="${w}" height="${h}" style="fill:none;stroke:${color};stroke-width:2"/>`;
      })
      .join('');
    const svg = `<svg width="${maxX}" height="${maxY}">${svgRects}</svg>`;
    const svgBuf = Buffer.from(svg);
    const base = sharp(full, {
      raw: { width: maxX, height: maxY, channels: 4 },
    });
    const overlay = sharp({
      create: {
        width: maxX,
        height: maxY,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    }).png();
    const overlayBuf = await overlay
      .composite([{ input: svgBuf, blend: 'over' }])
      .toBuffer();
    const annotated = await base
      .composite([{ input: overlayBuf, blend: 'over' }])
      .png()
      .toBuffer();
    const outPath =
      process.argv[3] || path.join(process.cwd(), 'annotated_tiled_image.png');
    await fs.writeFile(outPath, annotated);
    console.log('Saved annotated image to', outPath);
  } catch (e) {
    console.error('view_tiled_image failed:', e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
