/**
 * Session Manager - save and restore iterator state between interrupted runs
 */

import type { SessionState } from './types.js';
import { readJSON, writeJSON, fileExists } from '../utils/file-utils.js';
import { join } from 'path';

const SESSION_FILE = '.session.json';

/**
 * Session Manager class
 */
export class SessionManager {
  private readonly sessionPath: string;

  constructor(directory: string) {
    this.sessionPath = join(directory, SESSION_FILE);
  }

  /**
   * Check if a session file exists
   */
  async exists(): Promise<boolean> {
    return fileExists(this.sessionPath);
  }

  /**
   * Create a new session at the start of a run
   */
  async create(tool: string, branchName: string): Promise<SessionState> {
    const state: SessionState = {
      currentIteration: 0,
      completedStoryIds: [],
      lastStoryId: null,
      timestamp: new Date().toISOString(),
      tool,
      branchName,
    };
    await writeJSON(this.sessionPath, state);
    return state;
  }

  /**
   * Load an existing session
   */
  async load(): Promise<SessionState> {
    return readJSON<SessionState>(this.sessionPath);
  }

  /**
   * Update session state after a story completion.
   * No-op if session file doesn't exist (e.g., already cleaned up after completion).
   */
  async update(state: Partial<SessionState>): Promise<void> {
    if (!(await this.exists())) return;
    const current = await this.load();
    Object.assign(current, state, { timestamp: new Date().toISOString() });
    await writeJSON(this.sessionPath, current);
  }

  /**
   * Delete the session file (clean exit)
   */
  async delete(): Promise<void> {
    const { unlink } = await import('fs/promises');
    try {
      await unlink(this.sessionPath);
    } catch {
      // File may already be gone — ignore
    }
  }

  /**
   * Get the session file path
   */
  getPath(): string {
    return this.sessionPath;
  }
}

/**
 * Create a session manager instance
 */
export function createSessionManager(directory: string): SessionManager {
  return new SessionManager(directory);
}
