// Simple micro-benchmark for worker IPC cost in pixel copy paths.
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads';

if (!isMainThread) {
  const { mode, width, height, channels, batch, sab } = workerData;
  const row = new Uint8Array(width * channels);
  const start = Date.now();
  if (mode === 'pixel') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        parentPort.postMessage({ x, y, r: 1, g: 2, b: 3, a: 255 });
      }
    }
  } else if (mode === 'row') {
    for (let y = 0; y < height; y++) parentPort.postMessage({ y, data: row });
  } else if (mode === 'rowBatch') {
    const b = Math.max(1, batch | 0);
    for (let y = 0; y < height; y += b) {
      const count = Math.min(b, height - y);
      const buf = new Uint8Array(width * channels * count);
      parentPort.postMessage({ y0: y, count, data: buf });
    }
  } else if (mode === 'shared') {
    const view = new Uint8Array(sab);
    const stride = width * channels;
    for (let y = 0; y < height; y++) {
      const off = y * stride;
      // write a dummy pattern
      for (let i = 0; i < stride; i++) view[off + i] = (i + y) & 255;
    }
  }
  parentPort.postMessage({ done: true, took: Date.now() - start });
  process.exit(0);
}

function run(mode, w = 256, h = 256, c = 4) {
  return new Promise((resolve, reject) => {
    const wkr = new Worker(new URL(import.meta.url), {
      workerData: { mode, width: w, height: h, channels: c },
    });
    let msgs = 0;
    let took = 0;
    wkr.on('message', (m) => {
      msgs++;
      if (m.done) took = m.took;
    });
    wkr.once('error', reject);
    wkr.once('exit', () => resolve({ msgs, took }));
  });
}

const A = await run('pixel');
const B = await run('row');
console.log('[bench-ipc] per-pixel  msgs=', A.msgs, 'took', A.took, 'ms');
console.log('[bench-ipc] per-row    msgs=', B.msgs, 'took', B.took, 'ms');

for (const bs of [1, 4, 16, 64]) {
  const R = await new Promise((resolve, reject) => {
    const wkr = new Worker(new URL(import.meta.url), {
      workerData: {
        mode: 'rowBatch',
        width: 256,
        height: 256,
        channels: 4,
        batch: bs,
      },
    });
    let msgs = 0;
    let took = 0;
    wkr.on('message', (m) => {
      msgs++;
      if (m.done) took = m.took;
    });
    wkr.once('error', reject);
    wkr.once('exit', () => resolve({ msgs, took }));
  });
  console.log(
    `[bench-ipc] row-batch(${bs}) msgs=`,
    R.msgs,
    'took',
    R.took,
    'ms',
  );
}

const shared = await new Promise((resolve, reject) => {
  const sab = new SharedArrayBuffer(256 * 256 * 4);
  const wkr = new Worker(new URL(import.meta.url), {
    workerData: { mode: 'shared', width: 256, height: 256, channels: 4, sab },
  });
  let msgs = 0;
  let took = 0;
  wkr.on('message', (m) => {
    msgs++;
    if (m.done) took = m.took;
  });
  wkr.once('error', reject);
  wkr.once('exit', () => resolve({ msgs, took }));
});
console.log(
  '[bench-ipc] shared buf msgs=',
  shared.msgs,
  'took',
  shared.took,
  'ms',
);
