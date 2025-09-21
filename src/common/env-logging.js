/* eslint-disable no-console */
// env-logging.js
// Silences console output unless DEBUG is truthy.
// DEBUG accepted values: 1, true, yes, on, debug (case-insensitive)

const isDebug = /^(1|true|yes|on|debug)$/i.test(process.env.DEBUG || '');

if (!isDebug) {
  const noop = () => {};
  // keep errors visible
  console.log = noop;
  console.info = noop;
  console.debug = noop;
  console.warn = noop;
}

export {}; // ESM module
