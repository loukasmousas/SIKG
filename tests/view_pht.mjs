// view_pht.mjs
import sharp from 'sharp';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function loadPHT(filePath) {
  const fileContent = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(fileContent);
}

function reconstructImage(pixelMatrix) {
  const { width: _width, height: _height, channels, pixels } = pixelMatrix;
  if (channels !== 4)
    throw new Error(`Unsupported channels: ${channels}. Expected 4 (RGBA).`);
  return Buffer.from(pixels);
}

async function drawRegions(imageBuffer, info, regions) {
  const { width: _width, height: _height } = info;
  sharp(imageBuffer, { raw: { width: _width, height: _height, channels: 4 } });
  const overlay = sharp({
    create: {
      width: _width,
      height: _height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png();
  const svgRects = regions
    .map((r) => {
      const { x1, y1, x2, y2 } = r.boundary;
      const w = x2 - x1;
      const h = y2 - y1;
      const color = r.tags.includes('person') ? 'red' : 'blue';
      return `<rect x="${x1}" y="${y1}" width="${w}" height="${h}" style="fill:none;stroke:${color};stroke-width:2"/>`;
    })
    .join('');
  const svg = `<svg width="${_width}" height="${_height}">${svgRects}</svg>`;
  const svgBuffer = Buffer.from(svg);
  const annotatedOverlay = await overlay
    .composite([{ input: svgBuffer, blend: 'over' }])
    .toBuffer();
  return sharp(imageBuffer, {
    raw: { width: _width, height: _height, channels: 4 },
  })
    .composite([{ input: annotatedOverlay, blend: 'over' }])
    .png()
    .toBuffer();
}

async function main() {
  try {
    const phtPath = process.argv[2] || join(process.cwd(), 'imageData.pht');
    const out = process.argv[3] || join(process.cwd(), 'annotated_image.png');
    const data = await loadPHT(phtPath);
    const { pixelMatrix, regionManager } = data;
    const imgBuf = reconstructImage(pixelMatrix);
    const regions = regionManager.regions || [];
    if (!regions.length) {
      console.log('No regions to display.');
      return;
    }
    const annotated = await drawRegions(
      imgBuf,
      { width: pixelMatrix.width, height: pixelMatrix.height },
      regions,
    );
    await fs.writeFile(out, annotated);
    console.log('Annotated image saved to', out);
  } catch (e) {
    console.error('view_pht failed:', e.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
