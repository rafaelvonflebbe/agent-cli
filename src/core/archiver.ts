/**
 * Archive management for previous runs
 */

import type { ArchiveCheckResult, ArchiveInfo } from './types.js';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import {
  fileExists,
  readText,
  writeText,
  ensureDir,
  copyFileTo,
  fileExistsSync,
} from '../utils/file-utils.js';
import { info, warn } from '../utils/logger.js';

/** Last branch file name */
const LAST_BRANCH_FILE = '.last-branch';

/** Archive directory name */
const ARCHIVE_DIR = 'archive';

/** Progress file name */
const PROGRESS_FILE = 'progress.txt';

/** PRD file name */
const PRD_FILE = 'prd.json';

/**
 * Archiver class for managing run archives
 */
export class Archiver {
  private readonly directory: string;
  private readonly lastBranchPath: string;
  private readonly archiveBasePath: string;

  constructor(directory: string) {
    this.directory = directory;
    this.lastBranchPath = join(directory, LAST_BRANCH_FILE);
    this.archiveBasePath = join(directory, ARCHIVE_DIR);
  }

  /**
   * Check if archiving is needed and perform it
   */
  async checkAndArchive(currentBranch: string): Promise<ArchiveCheckResult> {
    const previousBranch = await this.readLastBranch();

    // No previous branch or same branch - no archive needed
    if (!previousBranch || previousBranch === currentBranch) {
      // Update last branch file
      await this.writeLastBranch(currentBranch);
      return {
        archived: false,
        currentBranch,
      };
    }

    // Branch changed - archive the previous run
    info(`Branch changed from '${previousBranch}' to '${currentBranch}'`);
    const archiveInfo = await this.archive(previousBranch);

    // Reset progress file for new run
    await this.resetProgressFile();

    // Update last branch file
    await this.writeLastBranch(currentBranch);

    return {
      archived: true,
      archive: archiveInfo,
      previousBranch,
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
  async resetProgressFile(): Promise<void> {
    const progressPath = join(this.directory, PROGRESS_FILE);
    const header = `# Agent CLI Progress Log
Started: ${new Date().toISOString()}
---
`;
    await writeText(progressPath, header);
    info('Reset progress file for new run');
  }

  /**
   * Read the last branch from file
   */
  private async readLastBranch(): Promise<string | null> {
    if (!fileExistsSync(this.lastBranchPath)) {
      return null;
    }

    try {
      return await readText(this.lastBranchPath);
    } catch {
      return null;
    }
  }

  /**
   * Write the current branch to last branch file
   */
  private async writeLastBranch(branch: string): Promise<void> {
    await writeText(this.lastBranchPath, branch);
  }

  /**
   * Initialize progress file if it doesn't exist
   */
  async initProgressFile(): Promise<void> {
    const progressPath = join(this.directory, PROGRESS_FILE);

    if (fileExistsSync(progressPath)) {
      return;
    }

    await this.resetProgressFile();
  }

  /**
   * Initialize archive system (checks for existing progress file)
   */
  async initialize(currentBranch: string): Promise<void> {
    await this.initProgressFile();
    await this.writeLastBranch(currentBranch);
  }
}

/**
 * Create an archiver instance
 */
export function createArchiver(directory: string): Archiver {
  return new Archiver(directory);
}
