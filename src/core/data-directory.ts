/**
 * Data directory resolver — determines where agent-cli operational files live.
 *
 * Resolution order:
 *   1. `.tmp/prd.json` exists → use `.tmp/`
 *   2. `prd.json` exists in root → use root (backward compat)
 *   3. Neither → default to `.tmp/` (for `--init`)
 */

import { join } from 'path';
import { fileExistsSync } from '../utils/file-utils.js';

const TMP_DIR = '.tmp';

/**
 * Resolve the data directory for a given project directory.
 * Returns the path where operational files (prd.json, progress.log, etc.) live.
 */
export function resolveDataDirectory(directory: string): string {
  const tmpPrdPath = join(directory, TMP_DIR, 'prd.json');
  if (fileExistsSync(tmpPrdPath)) {
    return join(directory, TMP_DIR);
  }

  const rootPrdPath = join(directory, 'prd.json');
  if (fileExistsSync(rootPrdPath)) {
    return directory;
  }

  // No prd.json anywhere — default to .tmp/ (used by --init)
  return join(directory, TMP_DIR);
}
