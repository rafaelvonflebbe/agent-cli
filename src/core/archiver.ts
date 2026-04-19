/**
 * Archive management for previous runs
 */

import type { ArchiveCheckResult, ArchiveInfo } from './types.js';
import { join } from 'path';
import {
  readText,
  writeText,
  ensureDir,
  copyFileTo,
  fileExistsSync,
} from '../utils/file-utils.js';
import { info, warn } from '../utils/logger.js';
import { rename } from 'fs/promises';

/** Archive directory name */
const ARCHIVE_DIR = 'archive';

/** Progress file name */
const PROGRESS_FILE = 'progress.log';

/** Legacy progress file name (for migration) */
const LEGACY_PROGRESS_FILE = 'progress.txt';

/** PRD file name */
const PRD_FILE = 'prd.json';

/**
 * Archiver class for managing run archives
 */
export class Archiver {
  private readonly directory: string;
  private readonly archiveBasePath: string;

  constructor(directory: string) {
    this.directory = directory;
    this.archiveBasePath = join(directory, ARCHIVE_DIR);
  }

  /**
   * Check if archiving is needed and perform it.
   * Branch-change archiving was previously handled via .last-branch comparison,
   * but that mechanism was dead code (initialize wrote before checkAndArchive read).
   * Now a no-op — branch switching is handled by stale branch detection in the iterator.
   */
  async checkAndArchive(currentBranch: string): Promise<ArchiveCheckResult> {
    return {
      archived: false,
      currentBranch,
    };
  }

  /**
   * Archive the current run
   */
  async archive(branchName: string): Promise<ArchiveInfo> {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const featureName = branchName.replace(/\//g, '-'); // Sanitize slashes for flat filenames
    const archiveDir = join(this.archiveBasePath, `${dateStr}-${featureName}`);

    info(`Archiving previous run to: ${archiveDir}`);

    // Create archive directory
    await ensureDir(archiveDir);

    // Archive PRD if it exists — include branch name in filename
    const prdPath = join(this.directory, PRD_FILE);
    if (fileExistsSync(prdPath)) {
      const prdArchiveName = `prd_${featureName}.json`;
      const prdArchivePath = join(archiveDir, prdArchiveName);
      await copyFileTo(prdPath, prdArchivePath);
      info(`  Archived: ${prdArchiveName}`);
    }

    // Archive progress file if it exists and has content — include branch name in filename
    const progressPath = join(this.directory, PROGRESS_FILE);
    if (fileExistsSync(progressPath)) {
      const progressContent = await readText(progressPath);
      if (this.hasProgressContent(progressContent)) {
        const progressArchiveName = `progress_${featureName}.log`;
        const progressArchivePath = join(archiveDir, progressArchiveName);
        await copyFileTo(progressPath, progressArchivePath);
        info(`  Archived: ${progressArchiveName}`);
      }
    }

    return {
      path: archiveDir,
      featureName,
      date,
    };
  }

  /**
   * Check if progress file has actual content (beyond headers)
   */
  private hasProgressContent(content: string): boolean {
    // Check for timestamped entries like [2026-04-19T22:24:38.203Z]
    return content.includes('[20');
  }

  /**
   * Reset the progress file for a new run
   */
  async resetProgressFile(branchName?: string): Promise<void> {
    const progressPath = join(this.directory, PROGRESS_FILE);
    const header = `# Agent CLI Progress Log
Branch: ${branchName || 'unknown'}
Started: ${new Date().toISOString()}
---
`;
    await writeText(progressPath, header);
    info('Reset progress file for new run');
  }

  /**
   * Initialize progress file if it doesn't exist.
   * Migrates legacy progress.txt to progress.log if needed.
   */
  async initProgressFile(branchName?: string): Promise<void> {
    const progressPath = join(this.directory, PROGRESS_FILE);
    const legacyPath = join(this.directory, LEGACY_PROGRESS_FILE);

    // Migrate legacy progress.txt → progress.log
    if (fileExistsSync(legacyPath) && !fileExistsSync(progressPath)) {
      try {
        await rename(legacyPath, progressPath);
        info(`Migrated ${LEGACY_PROGRESS_FILE} → ${PROGRESS_FILE}`);
      } catch {
        warn(`Failed to migrate ${LEGACY_PROGRESS_FILE} to ${PROGRESS_FILE}`);
      }
    }

    if (fileExistsSync(progressPath)) {
      return;
    }

    await this.resetProgressFile(branchName);
  }

  /**
   * Initialize archive system (checks for existing progress file)
   */
  async initialize(currentBranch: string): Promise<void> {
    await this.initProgressFile(currentBranch);
  }
}

/**
 * Create an archiver instance
 */
export function createArchiver(directory: string): Archiver {
  return new Archiver(directory);
}
