// transcribe.js
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const CLI = resolve(
  __dirname,
  'node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/whisper-cli',
);
const MODEL = resolve(
  __dirname,
  'node_modules/nodejs-whisper/cpp/whisper.cpp/models/ggml-small.en.bin',
); // models: ggml-tiny.en.bin, ggml-small.en.bin, ggml-large-v3-turbo.bin

export async function transcribe(wavPath) {
  const { stdout } = await exec(CLI, [
    '-m',
    MODEL,
    '-f',
    resolve(wavPath),
    '-nt', // no timestamps
  ]);
  return stdout.trim();
}

// quick test
transcribe('./hello.wav').then(console.log); // should print "Hello, how are you?"
