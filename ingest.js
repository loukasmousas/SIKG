/********************************************************************
 * ingest.js  – high-throughput batch driver.
 *   · loads the ML models once per process
 *   · feeds images to the proper pipeline with a small concurrency pool
 *     (override with --parallel N or env PHT_PARALLEL / INGEST_PARALLEL)
 *******************************************************************/

import 'dotenv/config'; // load .env before reading env vars
import './src/common/env-logging.js'; // silence logs unless DEBUG is set
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import sharp from 'sharp';
import { program } from 'commander';

import { processImage as runSingle } from './src/single/Main.js';
import { processImage as runTiled } from './src/tiled/TiledMLMain.js';
import { logger } from './src/common/logger.js';
import { ensureDefaultSlimJson } from './src/common/env-defaults.js';

// Default: no slimming unless user explicitly opts in (PHT_SLIM_JSON=1|true|yes)
ensureDefaultSlimJson('ingest');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN_DIR = path.join(__dirname, 'input-images');
const SIZE_LIMIT = 4000 * 3000; // 12 MP  (adjustable)

/* simple promise pool ------------------------------------------- */
async function pool(items, limit, fn) {
  const it = items[Symbol.iterator]();
  const work = new Set();
  const next = () => {
    const { value, done } = it.next();
    if (done) return;
    const p = fn(value)
      .catch(logger.error)
      .finally(() => {
        work.delete(p);
        next();
      });
    work.add(p);
    if (work.size < limit) next();
  };
  next();
  await Promise.all(work);
}

(async () => {
  await fs.mkdir(IN_DIR, { recursive: true });

  // CLI flags
  program
    .option(
      '--profile <profile>',
      'performance profile (fast|balanced|quality)',
      process.env.PERF_PROFILE || 'balanced',
    )
    .allowUnknownOption();
  program.parse();
  const { profile } = program.opts();
  const argv = process.argv.slice(2);
  // --privacy on|off|true|false|1|0
  const pIdx = argv.indexOf('--privacy');
  let facePrivacy = true; // default ON
  if (pIdx !== -1) {
    const v = (argv[pIdx + 1] || '').toLowerCase();
    facePrivacy = /^(1|true|on|yes)$/i.test(v);
  } else if (process.env.FACE_PRIVACY != null) {
    facePrivacy = /^(1|true|on|yes)$/i.test(String(process.env.FACE_PRIVACY));
  }

  // Concurrency: default one image per core; allow override via CLI/env
  let parallel = os.cpus().length;
  const parIdx = argv.indexOf('--parallel');
  if (parIdx !== -1) {
    const v = parseInt(argv[parIdx + 1], 10);
    if (Number.isFinite(v) && v > 0) parallel = v;
  } else if (process.env.PHT_PARALLEL || process.env.INGEST_PARALLEL) {
    const v = parseInt(
      process.env.PHT_PARALLEL || process.env.INGEST_PARALLEL,
      10,
    );
    if (Number.isFinite(v) && v > 0) parallel = v;
  }

  const files = (await fs.readdir(IN_DIR)).filter((f) =>
    /\.(jpe?g|png|tiff?)$/i.test(f),
  );

  if (!files.length) {
    logger.info('input-images/ is empty – nothing to do');
    return;
  }

  await pool(files, parallel, async (fn) => {
    const full = path.join(IN_DIR, fn);
    const { width, height } = await sharp(full).metadata();
    const pixels = width * height;
    const useTiled = pixels > SIZE_LIMIT;

    logger.info(
      `${fn} (${width}×${height}, ${Math.round(pixels / 1e6)} MP) → ${useTiled ? 'tiled' : 'single'}`,
    );

    if (useTiled)
      await runTiled(full, { performanceProfile: profile, facePrivacy });
    else await runSingle(full, { performanceProfile: profile, facePrivacy });
  });

  logger.info(`ingest done (parallel=${parallel})`);
})();
