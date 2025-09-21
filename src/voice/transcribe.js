// transcribe.js  – tiny wrapper around nodejs-whisper CLI
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../common/logger.js';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.cwd();

// Attempt to resolve whisper-cli dynamically – path can vary if script moved or run from root.
import fs from 'node:fs';
function findWhisperCli() {
  const candidates = [
    resolve(
      __dirname,
      'node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/whisper-cli',
    ),
    resolve(
      process.cwd(),
      'node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/whisper-cli',
    ),
  ];
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
    } catch {
      // ignore missing candidate path
    }
  }
  return candidates[0];
}

const CLI = findWhisperCli();
// Model file name based on WHISPER_MODEL env (maps small.en -> ggml-small.en.bin)
const whisperModelName = process.env.WHISPER_MODEL || 'small.en';
const ggmlFile = `ggml-${whisperModelName}.bin`; // nodejs-whisper naming convention

function findWhisperModel() {
  // Highest priority: explicit file path
  const envFile = process.env.WHISPER_MODEL_FILE;
  if (envFile) {
    const abs = isAbsolute(envFile) ? envFile : resolve(PROJECT_ROOT, envFile);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) return abs;
    } catch {
      // ignore missing explicit model file
    }
  }
  // Next: explicit dir override
  const envDir = process.env.WHISPER_MODEL_DIR;
  if (envDir) {
    const dirAbs = isAbsolute(envDir) ? envDir : resolve(PROJECT_ROOT, envDir);
    try {
      const st = fs.statSync(dirAbs);
      if (st.isDirectory()) {
        const p = join(dirAbs, ggmlFile);
        const st2 = fs.statSync(p);
        if (st2.isFile()) return p;
      }
    } catch {
      // ignore missing override dir or model file
    }
  }
  // Default: project root node_modules (correct location installed by nodejs-whisper)
  const candidates = [
    resolve(
      PROJECT_ROOT,
      'node_modules/nodejs-whisper/cpp/whisper.cpp/models',
      ggmlFile,
    ),
    resolve(
      __dirname,
      'node_modules/nodejs-whisper/cpp/whisper.cpp/models',
      ggmlFile,
    ),
  ];
  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile()) return c;
    } catch {
      // ignore missing default model path
    }
  }
  return candidates[0];
}

const MODEL = findWhisperModel();

async function ensureBuilt() {
  if (!fs.existsSync(CLI)) {
    // Trigger build via npx nodejs-whisper (non-interactive) if binary missing
    try {
      await exec('npx', ['-y', 'nodejs-whisper', '--help']);
    } catch {
      // ignore; build script prints help then exits
    }
  }
}

export async function transcribe(wavPath) {
  await ensureBuilt();
  if (!fs.existsSync(CLI)) throw new Error(`whisper-cli not found at ${CLI}`);
  if (!fs.existsSync(MODEL))
    throw new Error(`Whisper model file missing: ${MODEL}`);
  // NodeJS-Whisper CLI invocation (local inference)
  const { stdout } = await exec(CLI, [
    '-m',
    MODEL,
    '-f',
    resolve(wavPath),
    '-nt',
  ]);
  return stdout.trim();
}

// CLI usage:  node transcribe.js hello.wav
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv[2];
  if (arg) {
    transcribe(arg)
      .then((txt) => {
        logger.info(txt);
      })
      .catch((e) => {
        logger.error('Transcription failed:', e.message);
        process.exitCode = 1;
      });
  } else {
    logger.error('Usage: node transcribe.js <file.wav>');
    process.exitCode = 1;
  }
}
