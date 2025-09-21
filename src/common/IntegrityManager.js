// IntegrityManager.js
//
// Purpose: Provide tamper‑evidence over pixel tile files (.pht) by computing/storing/verifying
// SHA‑256 hashes in the JSON manifest's `integrity` section.
//
// References
// - Node.js crypto hashing: https://nodejs.org/api/crypto.html#class-hash

import { createHash } from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { logger } from './logger.js';

/**
 * IntegrityManager
 * - Computes SHA-256 hashes of one or multiple .pht tile files
 * - Stores those hashes in the .json manifest
 * - Verifies them later to detect tampering
 *
 * Note: I skip hashing the .json itself to avoid the "chicken-and-egg" problem,
 * but you can adopt a sidecar approach if you also want to verify the JSON.
 */
/**
 * IntegrityManager
 *
 * Computes and verifies SHA‑256 hashes for one or more .pht files and stores them under
 *   {
 *     "integrity": { "tiles": [{file, hash}, ...], "algorithm": "sha256" }
 *   }
 * in the JSON manifest written by the Serializer.
 */
class IntegrityManager {
  /**
   * Compute the SHA-256 (hex) of a file at filePath.
   */
  // Similar pattern: Node.js crypto hashing example
  // https://nodejs.org/api/crypto.html#class-hash
  /**
   * Compute the SHA‑256 (hex) of a file at filePath.
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  static async computeFileHash(filePath) {
    const data = await fs.readFile(filePath);
    const hash = createHash('sha256');
    hash.update(data);
    return hash.digest('hex');
  }

  /**
   * Insert tile file hashes into the JSON's `integrity` section.
   *
   * Usage:
   *   await IntegrityManager.storeTileHashes(jsonFilePath, [tile0, tile1, ...]);
   * Then the JSON gains a structure like:
   *   "integrity": {
   *      "tiles": [
   *         { "file": "imageData_tile_0.pht", "hash": "abc123..." },
   *         { "file": "imageData_tile_1.pht", "hash": "def456..." }
   *      ],
   *      "algorithm": "sha256"
   *   }
   */
  /**
   * Insert tile file hashes into the manifest under `integrity.tiles`.
   * @param {string} jsonFilePath
   * @param {string[]} phtPaths
   */
  static async storeTileHashes(jsonFilePath, phtPaths) {
    // Read the JSON
    const jsonStr = await fs.readFile(jsonFilePath, 'utf-8');
    const data = JSON.parse(jsonStr);

    // Compute hashes for all tile files in parallel
    if (!phtPaths?.length) return; // nothing to hash for single-image JSON
    const baseDir = path.dirname(jsonFilePath);
    const tileEntries = await Promise.all(
      phtPaths.map(async (pht) => {
        const hash = await this.computeFileHash(pht);
        let rel = path.relative(baseDir, pht);
        if (!rel || rel === '' || rel === '.') {
          rel = path.basename(pht);
        }
        return { file: rel, hash };
      }),
    );

    // Insert into data.integrity
    data.integrity = {
      tiles: tileEntries,
      algorithm: 'sha256',
    };

    // Write updated JSON
    const updatedJson = JSON.stringify(data, null, 2);
    await fs.writeFile(jsonFilePath, updatedJson, 'utf-8');
    logger.info(
      `IntegrityManager: stored ${tileEntries.length} tile hash(es) in ${jsonFilePath}`,
    );
  }

  /**
   * Verifies tile file hashes by re-hashing each .pht and comparing with what's stored in the JSON.
   * Throws an error if any mismatch is found.
   */
  /**
   * Verify all `integrity.tiles` entries by recomputing hashes and comparing.
   * @param {string} jsonFilePath
   * @throws on any mismatch
   */
  static async verifyTileHashes(jsonFilePath) {
    const jsonStr = await fs.readFile(jsonFilePath, 'utf-8');
    const data = JSON.parse(jsonStr);

    if (!data.integrity || !data.integrity.tiles) {
      throw new Error(`No integrity.tiles found in ${jsonFilePath}`);
    }
    if (data.integrity.algorithm !== 'sha256') {
      throw new Error(`Unsupported algorithm: ${data.integrity.algorithm}`);
    }

    const tileEntries = data.integrity.tiles;
    const baseDir = path.dirname(jsonFilePath);
    for (const entry of tileEntries) {
      const filePath = path.isAbsolute(entry.file)
        ? entry.file
        : path.join(baseDir, entry.file);
      const expectedHash = entry.hash;
      const currentHash = await this.computeFileHash(filePath);
      if (currentHash !== expectedHash) {
        throw new Error(`Tile file ${filePath} hash mismatch! 
                  Expected: ${expectedHash}
                  Got:      ${currentHash}`);
      }
    }

    logger.info(
      `IntegrityManager: All tile hashes matched for ${jsonFilePath}`,
    );
    return true;
  }

  static async storeFileHashes(jsonFilePath, phtFilePath) {
    if (!phtFilePath)
      // safeguard
      throw new Error('storeFileHashes: phtFilePath is required');
    return this.storeTileHashes(jsonFilePath, [phtFilePath]);
  }

  static async verifyFileHashes(jsonFilePath) {
    return this.verifyTileHashes(jsonFilePath);
  }
}

export default IntegrityManager;
