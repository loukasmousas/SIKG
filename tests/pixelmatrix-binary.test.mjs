// pixelmatrix-binary.test.mjs
// Ensures toBinary/fromBinary is lossless for a patterned matrix.
import PixelMatrix from '../src/common/PixelMatrix.js';
import crypto from 'crypto';

function pattern(width, height, channels) {
  const pm = new PixelMatrix(width, height, channels);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = (x * 17 + y * 31) & 0xff;
      pm.setPixel(x, y, v, (v + 40) & 255, (v + 80) & 255, 255);
    }
  return pm;
}

function hash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const pm = pattern(32, 16, 4);
const bin = pm.toBinary();
const h1 = hash(bin);
const restored = PixelMatrix.fromBinary(pm.width, pm.height, pm.channels, bin);
const h2 = hash(restored.toBinary());
if (h1 !== h2) {
  console.error('PixelMatrix binary round-trip hash mismatch');
  process.exitCode = 1;
} else console.log('PixelMatrix binary symmetry test passed.');
