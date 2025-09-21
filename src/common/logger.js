/* eslint-disable no-console */
// Lightweight logger wrapper so we can remove direct console.* usages in code
// and keep eslint (no-console) satisfied elsewhere.
export const logger = {
  info: (...a) => (process.env.DEBUG ? console.log(...a) : undefined),
  warn: (...a) => (process.env.DEBUG ? console.warn(...a) : undefined),
  error: (...a) => console.error(...a), // always report errors
};
