// TiledMLMain.js  –  tiled pipeline
//
// Purpose: Driver for large images. Splits into tiles, runs ML per tile, merges by IoU,
// computes relationships, and writes a tiled manifest with per‑tile `.pht` files.
// See TiledMLProcessor and TiledMLSerializer for details.
import 'dotenv/config'; // load .env before env-dependent defaults
import '../common/env-logging.js'; // silence logs unless DEBUG is set
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import TiledMLProcessor from './TiledMLProcessor.js';
import TiledMLSerializer from './TiledMLSerializer.js';
import IntegrityManager from '../common/IntegrityManager.js';
import { logger } from '../common/logger.js';
import { ensureDefaultSlimJson } from '../common/env-defaults.js';
import { StageTimer } from '../common/perf-metrics.js';

// Default PHT_SLIM_JSON to 0 only if unset
ensureDefaultSlimJson('TiledMLMain');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function processImage(srcPath, opts = {}) {
  try {
    const timer = new StageTimer({
      flow: 'tiled',
      image: path.basename(srcPath),
      profile:
        opts.performanceProfile || process.env.PERF_PROFILE || 'balanced',
    });
    const buf = await fs.readFile(srcPath);
    timer.mark('readFile');

    const rawName = path.basename(srcPath, path.extname(srcPath));
    const safeName = rawName
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_-]/g, '');
    const outDir = path.join(process.cwd(), 'output');
    await fs.mkdir(outDir, { recursive: true });

    /* ── Run the tiled ML pipeline ────────────────── */
    const defaultPrivacy =
      process.env.FACE_PRIVACY != null
        ? /^(1|true|on|yes)$/i.test(String(process.env.FACE_PRIVACY))
        : true;
    const tp = new TiledMLProcessor(buf, {
      tileSize: 512,
      mergeRegions: true,
      iouThreshold: 0.5,
      safeName: safeName,
      performanceProfile:
        opts.performanceProfile || process.env.PERF_PROFILE || 'balanced',
      facePrivacy:
        opts.facePrivacy !== undefined ? !!opts.facePrivacy : defaultPrivacy,
    });
    await tp.processImage(timer);
    timer.mark('tile+detect+merge+relations');

    /* ── Serialize tiles + metadata ───────────────── */
    const jsonPath = path.join(outDir, `${safeName}.json`);
    await TiledMLSerializer.save(
      tp.tiles,
      tp.metadataIndex,
      tp.regionManager,
      jsonPath,
    );
    timer.mark('serialize');

    if (tp._rawModel && !process.env.SKIP_RAW_DUMP) {
      try {
        await fs.writeFile(
          path.join(outDir, `${safeName}.raw-model.json`),
          JSON.stringify(tp._rawModel, null, 2),
        );
      } catch {
        /* ignore */
      }
    }

    /* integrity manifest for .pht tiles */
    const tilePaths = tp.tiles.map((_, i) =>
      path.join(outDir, `${safeName}_tile_${i}.pht`),
    );
    await IntegrityManager.storeTileHashes(jsonPath, tilePaths);
    await IntegrityManager.verifyTileHashes(jsonPath);
    timer.mark('integrity');
    timer.flush({ ok: true });

    logger.info(`${safeName} → ${jsonPath} (+ ${tp.tiles.length} tiles)`);
  } catch (err) {
    logger.error(err);
    try {
      new StageTimer({ flow: 'tiled', image: srcPath }).flush({
        ok: false,
        error: String(err?.message || err),
      });
    } catch (_e) {
      /* ignore metrics flush failure */
    }
    throw err;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const img = args.find((a) => !a.startsWith('--'));
  const defaultPrivacy =
    process.env.FACE_PRIVACY != null
      ? /^(1|true|on|yes)$/i.test(String(process.env.FACE_PRIVACY))
      : true;
  const privIdx = args.indexOf('--privacy');
  let facePrivacy = defaultPrivacy;
  if (privIdx !== -1) {
    const val = (args[privIdx + 1] || '').toLowerCase();
    facePrivacy = /^(1|on|true|yes)$/i.test(val);
  }
  if (!img) {
    logger.error(
      `Usage: node TiledMLMain.js <image> [--profile fast|balanced|quality] [--privacy on|off] (default: ${
        defaultPrivacy ? 'on' : 'off'
      })`,
    );
    process.exit(1);
  }
  let profile = process.env.PERF_PROFILE || 'balanced';
  const pIdx = args.indexOf('--profile');
  if (pIdx !== -1 && args[pIdx + 1]) profile = args[pIdx + 1];
  processImage(img, { performanceProfile: profile, facePrivacy }).catch(() =>
    process.exit(1),
  );
}
