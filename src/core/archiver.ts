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
    const featureName = branchName.replace(/^ralph\//, ''); // Strip feature branch prefix
    const archiveDir = join(this.archiveBasePath, `${dateStr}-${featureName}`);

    info(`Archiving previous run to: ${archiveDir}`);

    // Create archive directory
    await ensureDir(archiveDir);

    // Archive PRD if it exists
    const prdPath = join(this.directory, PRD_FILE);
    if (fileExistsSync(prdPath)) {
      const prdArchivePath = join(archiveDir, PRD_FILE);
      await copyFileTo(prdPath, prdArchivePath);
      info(`  Archived: ${PRD_FILE}`);
    }

    // Archive progress file if it exists and has content
    const progressPath = join(this.directory, PROGRESS_FILE);
    if (fileExistsSync(progressPath)) {
      const progressContent = await readText(progressPath);
      // Only archive if there's actual progress (beyond just headers)
      if (this.hasProgressContent(progressContent)) {
        const progressArchivePath = join(archiveDir, PROGRESS_FILE);
        await copyFileTo(progressPath, progressArchivePath);
        info(`  Archived: ${PROGRESS_FILE}`);
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
    // Check for progress entries (lines starting with ##)
    const lines = content.split('\n');
    return lines.some(line => line.trim().startsWith('##') && !line.includes('Codebase Patterns'));
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
