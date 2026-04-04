/**
 * Git utilities for detecting file changes between iterations
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import chalk from 'chalk';

const execAsync = promisify(exec);

/**
 * Parsed status from a single line of `git status --porcelain`
 */
interface GitFileStatus {
  path: string;
  x: string;
  y: string;
}

/**
 * A detected file change between two git status snapshots
 */
export interface FileChange {
  path: string;
  type: 'added' | 'modified' | 'removed';
}

/**
 * Capture git status --porcelain output as a map of file path → status
 */
export async function captureGitStatus(directory: string): Promise<Map<string, GitFileStatus>> {
  const map = new Map<string, GitFileStatus>();

  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: directory });

    for (const line of stdout.split('\n')) {
      if (line.length < 4) continue;
      const x = line[0];
      const y = line[1];
      const path = line.slice(3);
      map.set(path, { path, x, y });
    }
  } catch {
    // Not a git repo or git not available — return empty map
  }

  return map;
}

/**
 * Compare two git status snapshots and return the diff
 */
export function diffGitStatus(
  before: Map<string, GitFileStatus>,
  after: Map<string, GitFileStatus>
): FileChange[] {
  const changes: FileChange[] = [];

  // Files that appeared in after but not in before
  for (const [path, status] of after) {
    if (!before.has(path)) {
      if (status.x === 'D' || status.y === 'D') {
        changes.push({ path, type: 'removed' });
      } else if (status.x === '?' && status.y === '?') {
        changes.push({ path, type: 'added' });
      } else if (status.x === 'A') {
        changes.push({ path, type: 'added' });
      } else {
        changes.push({ path, type: 'modified' });
      }
    }
  }

  // Files present in both but with changed status
  for (const [path, afterStatus] of after) {
    const beforeStatus = before.get(path);
    if (beforeStatus && (beforeStatus.x !== afterStatus.x || beforeStatus.y !== afterStatus.y)) {
      if (afterStatus.x === 'D' || afterStatus.y === 'D') {
        changes.push({ path, type: 'removed' });
      } else if (afterStatus.x === 'A' || (afterStatus.x === '?' && afterStatus.y === '?')) {
        changes.push({ path, type: 'added' });
      } else {
        changes.push({ path, type: 'modified' });
      }
    }
  }

  // Files in before but not in after (disappeared from status)
  for (const [path, beforeStatus] of before) {
    if (!after.has(path)) {
      if (beforeStatus.x === '?' && beforeStatus.y === '?') {
        // Untracked file that disappeared = deleted by the tool
        changes.push({ path, type: 'removed' });
      }
      // Tracked file that became clean = reverted, skip
    }
  }

  return changes;
}

/**
 * Display file changes with colored prefixes
 */
export function displayFileChanges(changes: FileChange[]): void {
  if (changes.length === 0) {
    console.log(chalk.gray('  No file changes detected'));
    return;
  }

  console.log(chalk.cyan(`  File changes (${changes.length}):`));

  for (const change of changes) {
    if (change.type === 'removed') {
      console.log(chalk.red(`  - ${change.path} (removed)`));
    } else {
      console.log(chalk.green(`  + ${change.path} (${change.type})`));
    }
  }
}
