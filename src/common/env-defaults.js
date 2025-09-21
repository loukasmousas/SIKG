// env-defaults.js
// Centralize defaulting of environment variables used across entrypoints.

import { logger } from './logger.js';

export function ensureDefaultSlimJson(context = '') {
  const who = context ? `[${context}] ` : '';
  if (process.env.PHT_SLIM_JSON === undefined) {
    process.env.PHT_SLIM_JSON = '0';
    logger.info(`${who}PHT_SLIM_JSON defaulting to 0 (no slimming).`);
  } else {
    logger.info(`${who}PHT_SLIM_JSON=${process.env.PHT_SLIM_JSON}`);
  }
}

export default { ensureDefaultSlimJson };
