/**
 * PRD (Product Requirements Document) management
 */

import type { PRD, UserStory, PRDStatus } from './types.js';
import { readJSON, writeJSON, fileExists, fileExistsSync } from '../utils/file-utils.js';
import { join } from 'path';
import { error, warn } from '../utils/logger.js';

/** Default PRD file name */
export const PRD_FILE = 'prd.json';

/**
 * PRD Manager class
 */
export class PRDManager {
  private prd: PRD | null = null;
  private readonly path: string;

  constructor(directory: string) {
    this.path = join(directory, PRD_FILE);
  }

  /**
   * Check if PRD file exists
   */
  exists(): boolean {
    return fileExistsSync(this.path);
  }

  /**
   * Load PRD from file
   * @throws Error if file doesn't exist or is invalid
   */
  async load(): Promise<PRD> {
    if (!this.exists()) {
      throw new Error(`PRD file not found: ${this.path}`);
    }

    try {
      this.prd = await readJSON<PRD>(this.path);
      this.validate(this.prd);
      return this.prd;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Failed to load PRD: ${message}`);
      throw err;
    }
  }

  /**
   * Get the loaded PRD
   * @throws Error if PRD not loaded
   */
  getPRD(): PRD {
    if (!this.prd) {
      throw new Error('PRD not loaded. Call load() first.');
    }
    return this.prd;
  }

  /**
   * Get PRD status
   */
  getStatus(): PRDStatus {
    const prd = this.getPRD();
    const total = prd.userStories.length;
    const completed = prd.userStories.filter(s => s.passes).length;
    const incomplete = total - completed;
    const allComplete = incomplete === 0;

    // Find highest priority incomplete story (lowest priority number = highest priority)
    const incompleteStories = prd.userStories
      .filter(s => !s.passes)
      .sort((a, b) => a.priority - b.priority);

    return {
      total,
      completed,
      incomplete,
      allComplete,
      nextStory: incompleteStories[0],
    };
  }

  /**
   * Update a story's pass status
   */
  async updateStory(storyId: string, passes: boolean): Promise<void> {
    const prd = this.getPRD();
    const story = prd.userStories.find(s => s.id === storyId);

    if (!story) {
      throw new Error(`Story not found: ${storyId}`);
    }

    story.passes = passes;
    await this.save();
  }

  /**
   * Save PRD to file
   */
  async save(): Promise<void> {
    if (!this.prd) {
      throw new Error('No PRD to save. Load or create a PRD first.');
    }

    await writeJSON(this.path, this.prd);
  }

  /**
   * Get the branch name from PRD
   */
  getBranchName(): string {
    const prd = this.getPRD();
    if (!prd.branchName) {
      throw new Error('PRD does not have a branchName');
    }
    return prd.branchName;
  }

  /**
   * Get the project name from PRD
   */
  getProjectName(): string {
    const prd = this.getPRD();
    return prd.project || 'Unknown';
  }

  /**
   * Validate PRD structure
   * @throws Error if PRD is invalid
   */
  private validate(prd: unknown): void {
    if (!prd || typeof prd !== 'object') {
      throw new Error('PRD must be an object');
    }

    const p = prd as Partial<PRD>;

    if (!p.project || typeof p.project !== 'string') {
      throw new Error('PRD must have a "project" string property');
    }

    if (!p.branchName || typeof p.branchName !== 'string') {
      throw new Error('PRD must have a "branchName" string property');
    }

    if (!Array.isArray(p.userStories)) {
      throw new Error('PRD must have a "userStories" array property');
    }

    // Validate each user story
    for (let i = 0; i < p.userStories.length; i++) {
      const story = p.userStories[i];
      if (!story.id || typeof story.id !== 'string') {
        throw new Error(`User story at index ${i} must have an "id" string property`);
      }
      if (!story.title || typeof story.title !== 'string') {
        throw new Error(`User story ${story.id} must have a "title" string property`);
      }
      if (typeof story.priority !== 'number') {
        throw new Error(`User story ${story.id} must have a "priority" number property`);
      }
      if (typeof story.passes !== 'boolean') {
        throw new Error(`User story ${story.id} must have a "passes" boolean property`);
      }
    }
  }

  /**
   * Check if all stories are complete
   */
  areAllStoriesComplete(): boolean {
    return this.getStatus().allComplete;
  }

  /**
   * Get the next story to work on
   */
  getNextStory(): UserStory | undefined {
    return this.getStatus().nextStory;
  }
}

/**
 * Create a PRD manager instance
 */
export function createPRDManager(directory: string): PRDManager {
  return new PRDManager(directory);
}
