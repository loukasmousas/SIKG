// Main.js  –  single-image pipeline
// ---------------------------------
//  • Generates <safeName>.json  +  <safeName>.pht
//  • Inserts SHA‑256 hash of the .pht into the JSON (integrity.tiles[0])
//  • Verifies the hash immediately (tamper‑evidence)
//
// Usage: node src/single/Main.js <image> [--profile fast|balanced|quality]
// Profiles tune whether DeepLab runs (balanced/quality) and spatial thresholds.

import 'dotenv/config'; // load .env first so PHT_SLIM_JSON is available
import '../common/env-logging.js'; // silence logs unless DEBUG is set
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import ImageProcessor from './ImageProcessor.js';
import Serializer from '../common/Serializer.js';
import IntegrityManager from '../common/IntegrityManager.js';
import { logger } from '../common/logger.js';
import { ensureDefaultSlimJson } from '../common/env-defaults.js';
import { StageTimer } from '../common/perf-metrics.js';

// Default PHT_SLIM_JSON to 0 only if unset
ensureDefaultSlimJson('Main');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** reusable worker ------------------------------------------------- */
/**
 * Process a single image end‑to‑end (decode → ML → relationships → serialize → integrity).
 * @param {string} srcPath - path to input image
 * @param {{performanceProfile?:string,facePrivacy?:boolean}} opts
 */
export async function processImage(srcPath, opts = {}) {
  try {
    const rawName0 = path.basename(srcPath);
    const timer = new StageTimer({
      flow: 'single',
      image: rawName0,
      profile: opts.performanceProfile || 'balanced',
    });
    const buf = await fs.readFile(srcPath);
    timer.mark('readFile');

    const rawName = path.basename(srcPath, path.extname(srcPath));
    const safeName = rawName
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_-]/g, '');
    const outDir = path.join(process.cwd(), 'output');
    await fs.mkdir(outDir, { recursive: true });

    /* ───── ML pipeline ───── */
    const ip = new ImageProcessor(buf, safeName, {
      mergeRegions: true,
      mergeIoUThreshold: 0.5,
      onDemandPixelStorage: true,
      safeName: safeName,
      performanceProfile: opts.performanceProfile || 'balanced',
      facePrivacy: opts.facePrivacy,
    });
    await ip.processImage(timer);
    timer.mark('ml+copy+relations');

    /* ───── Serialization ───── */
    const jsonPath = path.join(outDir, `${safeName}.json`);
    const ser = new Serializer(
      ip.pixelMatrix,
      ip.metadataIndex,
      ip.regionManager,
    );
    await ser.save(jsonPath); // writes <safeName>.pht too
    timer.mark('serialize');
    // Write raw model dump (detections) for transformation fidelity eval
    if (ip._rawModel && !process.env.SKIP_RAW_DUMP) {
      try {
        await fs.writeFile(
          path.join(outDir, `${safeName}.raw-model.json`),
          JSON.stringify(ip._rawModel, null, 2),
        );
      } catch {
        /* ignore */
      }
    }

    /* ───── Integrity (single-file case) ───── */
    const phtPath = path.join(outDir, `${safeName}.pht`);

    await IntegrityManager.storeFileHashes(jsonPath, phtPath);
    await IntegrityManager.verifyFileHashes(jsonPath);
    timer.mark('integrity');
    timer.flush({ ok: true });

    logger.info(`${safeName} → ${jsonPath}`);
  } catch (err) {
    logger.error(err);
    try {
      new StageTimer({ flow: 'single', image: srcPath }).flush({
        ok: false,
        error: String(err?.message || err),
      });
    } catch (_e) {
      /* ignore metrics flush failure */
    }
    throw err;
  }
}

/* CLI wrapper keeps old behaviour --------------------------------- */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const img = args.find((a) => !a.startsWith('--'));
  const defaultPrivacy =
    process.env.FACE_PRIVACY != null
      ? /^(1|true|on|yes)$/i.test(String(process.env.FACE_PRIVACY))
      : true;
  // --privacy on|off|true|false|1|0
  const privIdx = args.indexOf('--privacy');
  let facePrivacy = defaultPrivacy;
  if (privIdx !== -1) {
    const val = (args[privIdx + 1] || '').toLowerCase();
    facePrivacy = /^(1|on|true|yes)$/i.test(val);
  }
  if (!img) {
    logger.error(
      `Usage: node Main.js <image> [--profile fast|balanced|quality] [--privacy on|off] (default: ${
        defaultPrivacy ? 'on' : 'off'
      })`,
    );
    process.exit(1);
  }
  const profileFlagIdx = args.indexOf('--profile');
  let profile = process.env.PERF_PROFILE || 'balanced';
  if (profileFlagIdx !== -1 && args[profileFlagIdx + 1])
    profile = args[profileFlagIdx + 1];
  processImage(img, { performanceProfile: profile, facePrivacy }).catch(
    () => (process.exitCode = 1),
  );
}
