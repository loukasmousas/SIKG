// deeplabCheck.mjs  - stand-alone CLI or unit-test helper
import * as tf from '@tensorflow/tfjs-node';
import * as deeplab from '@tensorflow-models/deeplab';
import fs from 'fs/promises';
import sharp from 'sharp';

// ---------- Load model ---------------------------------------------------
const model = await deeplab.load({ base: 'ade20k', quantizationBytes: 2 });

// ---------- Pick an image -----------------------------------------------
const imgPath = process.argv[2] || 'tests/architecture.jpg';
const imgBuf = await fs.readFile(imgPath);

// ---------- Tensor prep (RGBA → RGB → 513×513) ---------------------------
const { data, info } = await sharp(imgBuf)
  .raw()
  .ensureAlpha()
  .toBuffer({ resolveWithObject: true });
const rgbTensor = tf
  .tensor3d(Array.from(data), [info.height, info.width, info.channels], 'int32')
  .slice([0, 0, 0], [info.height, info.width, 3]); // drop α
const resized = tf.image.resizeBilinear(rgbTensor, [513, 513], false).toInt();

// ---------- Run segmentation --------------------------------------------
const { segmentationMap, legend } = await model.segment(resized);
resized.dispose();

// ---------- Inspect class-ids -------------------------------------------
const ids = [...new Set(segmentationMap)];
console.log(
  'Distinct class-ids (first 15):',
  ids.slice(0, 15),
  '… total:',
  ids.length,
);

ids.slice(0, 10).forEach((id) => {
  const entry = legend[id] || legend[String(id)];
  const name = entry?.name || entry?.label || `class-${id}`;
  console.log(id.toString().padStart(3), '→', name);
});

// ---------- Simple “test” outcome ---------------------------------------
if (ids.every((id) => id === 0)) {
  console.error('DeepLab output is background only – check preprocessing.');
  process.exitCode = 1; // non‑zero = failure signal for CI / Jest runner
}
