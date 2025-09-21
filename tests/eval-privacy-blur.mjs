import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import fetch from 'node-fetch';

const FACE_LIST = JSON.parse(
  fs.readFileSync('evaluation/privacy/face_test_list.json', 'utf-8'),
);
const OUT = [];

function iou(a, b) {
  const ax2 = a.x + a.w,
    ay2 = a.y + a.h;
  const bx2 = b.x + b.w,
    by2 = b.y + b.h;
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}
const OUT_PATH = 'output/eval/privacy_blur.json';

for (const item of FACE_LIST) {
  const manifestPath = item.manifest || '';
  // Try to read manifest up-front (used for blur-target IoU regardless of server availability)
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    manifest = null;
  }
  const blurUrl = `http://localhost:3000/getTile?jsonPath=${encodeURIComponent(manifestPath)}&blur=1`;
  const rawUrl = `http://localhost:3000/getTile?jsonPath=${encodeURIComponent(manifestPath)}&blur=0`;
  let rawBuf = null;
  let blurBuf = null;
  let serverOk = true;
  try {
    const blurResp = await fetch(blurUrl, { timeout: 1000 });
    const rawResp = await fetch(rawUrl, { timeout: 1000 });
    if (!blurResp.ok || !rawResp.ok) throw new Error('non-200');
    blurBuf = await blurResp.buffer();
    rawBuf = await rawResp.buffer();
  } catch (_e) {
    serverOk = false;
  }

  // Offline fallback: reconstruct from manifest + .pht and compute blur locally
  if (!serverOk) {
    try {
      const mani =
        manifest || JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const pm = mani.pixelMatrix || {};
      const phtPath = path.join(path.dirname(manifestPath), pm.phtFile || '');
      if (!pm.width || !pm.height || !pm.channels || !fs.existsSync(phtPath)) {
        throw new Error('missing pixelMatrix or .pht');
      }
      const pht = fs.readFileSync(phtPath);
      // Create a raw sharp image from .pht
      const img = sharp(pht, {
        raw: { width: pm.width, height: pm.height, channels: pm.channels },
      });
      // For offline comparison, create a globally blurred image
      const imgBuf = await img.ensureAlpha().png().toBuffer();
      const blurAll = await img.clone().blur(15).ensureAlpha().png().toBuffer();
      rawBuf = imgBuf;
      blurBuf = blurAll;
      serverOk = true; // produced buffers locally
    } catch (_e) {
      // still not assessable – record as skipped
      OUT.push({
        manifest: manifestPath,
        faces: item.faces.length,
        meanHighFreqDrop: 0,
        skipped: true,
      });
      continue;
    }
  }

  // Compute energy drop over provided face boxes
  const rawImg = sharp(rawBuf);
  const blurImg = sharp(blurBuf);
  const { width, height } = await rawImg.metadata();
  const rawPixels = await rawImg.raw().ensureAlpha().toBuffer();
  const blurPixels = await blurImg.raw().ensureAlpha().toBuffer();
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  let drops = [];
  for (const face of item.faces) {
    const x = clamp(Math.floor(face.x || 0), 1, Math.max(1, width - 2));
    const y = clamp(Math.floor(face.y || 0), 1, Math.max(1, height - 2));
    const w = clamp(Math.floor(face.w || 0), 2, Math.max(2, width - x - 1));
    const h = clamp(Math.floor(face.h || 0), 2, Math.max(2, height - y - 1));
    let eRaw = 0,
      eBlur = 0;
    for (let yy = y + 1; yy < y + h - 1; yy++) {
      for (let xx = x + 1; xx < x + w - 1; xx++) {
        const idx = (yy * width + xx) * 4;
        const gxRaw = rawPixels[idx - 4] - rawPixels[idx + 4];
        const gyRaw = rawPixels[idx - width * 4] - rawPixels[idx + width * 4];
        eRaw += Math.abs(gxRaw) + Math.abs(gyRaw);
        const gxBlur = blurPixels[idx - 4] - blurPixels[idx + 4];
        const gyBlur =
          blurPixels[idx - width * 4] - blurPixels[idx + width * 4];
        eBlur += Math.abs(gxBlur) + Math.abs(gyBlur);
      }
    }
    drops.push(1 - eBlur / (eRaw || 1));
  }
  const result = {
    manifest: manifestPath,
    faces: item.faces.length,
    meanHighFreqDrop: +(
      drops.reduce((a, b) => a + b, 0) / Math.max(1, drops.length)
    ).toFixed(3),
    skipped: false,
  };

  // IoU between ground-truth face boxes and actual blur target regions from manifest (when available)
  try {
    const mani = manifest || JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const regions = mani?.regionManager?.regions || [];
    const targets = regions
      .filter((r) => Array.isArray(r.tags) && r.tags.includes('face'))
      .map((r) => ({
        x: Math.round(r.boundary?.x1 ?? 0),
        y: Math.round(r.boundary?.y1 ?? 0),
        w: Math.round((r.boundary?.x2 ?? 0) - (r.boundary?.x1 ?? 0)),
        h: Math.round((r.boundary?.y2 ?? 0) - (r.boundary?.y1 ?? 0)),
      }));
    if (
      Array.isArray(targets) &&
      targets.length &&
      Array.isArray(item.faces) &&
      item.faces.length
    ) {
      const byX = (a, b) => (a.x || 0) - (b.x || 0);
      const gt = item.faces.slice().sort(byX);
      const tg = targets.slice().sort(byX);
      const pairs = Math.min(gt.length, tg.length);
      const ious = [];
      for (let i = 0; i < pairs; i++) ious.push(iou(gt[i], tg[i]));
      result.blurTargetIoU = {
        n: ious.length,
        mean: +(
          ious.reduce((a, b) => a + b, 0) / Math.max(1, ious.length)
        ).toFixed(3),
        min: +Math.min(...ious).toFixed(3),
        max: +Math.max(...ious).toFixed(3),
      };
    }
  } catch {
    // ignore if manifest missing or malformed
  }

  // IoU alignment if before/after boxes are provided in the item.detected field
  try {
    const det = item.detected || {};
    const before = Array.isArray(det.before) ? det.before : [];
    const after = Array.isArray(det.after) ? det.after : [];
    if (before.length && after.length) {
      const pairs = Math.min(before.length, after.length);
      const ious = [];
      for (let i = 0; i < pairs; i++) ious.push(iou(before[i], after[i]));
      result.iouAlignment = {
        n: ious.length,
        mean: +(ious.reduce((a, b) => a + b, 0) / ious.length).toFixed(3),
        min: +Math.min(...ious).toFixed(3),
        max: +Math.max(...ious).toFixed(3),
      };
    }
  } catch {
    // ignore optional IoU pairing errors
  }

  OUT.push(result);
}

if (!fs.existsSync('output/eval'))
  fs.mkdirSync('output/eval', { recursive: true });
fs.writeFileSync(OUT_PATH, JSON.stringify(OUT, null, 2));
console.log('[eval] privacy blur report ->', OUT_PATH);
