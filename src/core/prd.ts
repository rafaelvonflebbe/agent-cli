/**
 * PRD (Product Requirements Document) management
 */

import type { PRD, UserStory, PRDStatus } from './types.js';
import { readJSON, writeJSON, fileExistsSync } from '../utils/file-utils.js';
import { join, dirname } from 'path';
import { error, warn } from '../utils/logger.js';
import Ajv from 'ajv';

/** Default PRD file name */
export const PRD_FILE = 'prd.json';

/** Schema file name */
export const PRD_SCHEMA_FILE = 'prd.schema.json';

/**
 * PRD Manager class
 */
export class PRDManager {
  private prd: PRD | null = null;
  private readonly path: string;
  private static schemaValidator: Ajv | null = null;

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
   * Get the Ajv schema validator (lazy-loaded, cached)
   */
  private async getSchemaValidator(): Promise<Ajv> {
    if (!PRDManager.schemaValidator) {
      const schemaPath = join(dirname(new URL(import.meta.url).pathname), '..', '..', PRD_SCHEMA_FILE);
      const schema = await readJSON<object>(schemaPath);
      const ajv = new Ajv({ allErrors: true });
      PRDManager.schemaValidator = ajv;
      ajv.addSchema(schema, 'prd');
    }
    return PRDManager.schemaValidator;
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
      await this.validateWithSchema(this.prd);
      this.validateDependencies(this.prd);
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
   * Check if a story's dependencies are all met
   */
  private areDependenciesMet(story: UserStory): boolean {
    if (!story.dependsOn || story.dependsOn.length === 0) {
      return true;
    }
    const prd = this.getPRD();
    return story.dependsOn.every(depId => {
      const dep = prd.userStories.find(s => s.id === depId);
      return dep?.passes === true;
    });
  }

  /**
   * Get unmet dependencies for a story
   */
  getUnmetDependencies(story: UserStory): string[] {
    if (!story.dependsOn || story.dependsOn.length === 0) {
      return [];
    }
    const prd = this.getPRD();
    return story.dependsOn.filter(depId => {
      const dep = prd.userStories.find(s => s.id === depId);
      return !dep || !dep.passes;
    });
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

    // Find highest priority incomplete story whose dependencies are met
    const eligibleStories = prd.userStories
      .filter(s => !s.passes && this.areDependenciesMet(s))
      .sort((a, b) => a.priority - b.priority);

    return {
      total,
      completed,
      incomplete,
      allComplete,
      nextStory: eligibleStories[0],
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
   * Update the branch name in PRD
   */
  async updateBranchName(branchName: string): Promise<void> {
    const prd = this.getPRD();
    prd.branchName = branchName;
    await this.save();
  }

  /**
   * Get the project name from PRD
   */
  getProjectName(): string {
    const prd = this.getPRD();
    return prd.project || 'Unknown';
  }

  /**
   * Migrate incomplete stories to a new PRD after archiving.
   * Replaces userStories with only those where passes: false,
   * resets passes to false on migrated stories, and updates branchName.
   * Returns counts of migrated and archived (completed) stories.
   * If all stories were complete, the PRD is left unchanged.
   */
  async migrateIncompleteStories(newBranchName: string): Promise<{ migrated: number; archived: number }> {
    const prd = this.getPRD();
    const incompleteStories = prd.userStories.filter(s => !s.passes);
    const archivedCount = prd.userStories.length - incompleteStories.length;

    if (incompleteStories.length === 0) {
      // All stories complete — leave PRD as-is
      return { migrated: 0, archived: archivedCount };
    }

    prd.userStories = incompleteStories.map(s => ({
      ...s,
      passes: false,
    }));
    prd.branchName = newBranchName;
    await this.save();

    return { migrated: incompleteStories.length, archived: archivedCount };
  }

  /**
   * Validate PRD against JSON schema
   * @throws Error if PRD is invalid
   */
  private async validateWithSchema(prd: unknown): Promise<void> {
    const ajv = await this.getSchemaValidator();
    const valid = ajv.validate('prd', prd);

    if (!valid) {
      const errors = ajv.errors?.map(e => {
        const field = e.instancePath ? e.instancePath.slice(1) : (e.params as { missingProperty?: string })?.missingProperty || '';
        return field ? `${field} ${e.message}` : e.message;
      }).join('; ');
      throw new Error(`PRD validation failed: ${errors}`);
    }
  }

  /**
   * Validate that all dependsOn IDs reference existing story IDs
   * Warns but does not crash on invalid references
   */
  private validateDependencies(prd: PRD): void {
    const storyIds = new Set(prd.userStories.map(s => s.id));
    for (const story of prd.userStories) {
      if (story.dependsOn) {
        for (const depId of story.dependsOn) {
          if (!storyIds.has(depId)) {
            warn(`Story ${story.id} depends on ${depId}, but no story with that ID exists`);
          }
        }
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

  /**
   * Evaluate stopWhen conditions with OR logic.
   * Returns { shouldStop: true, reason } if any condition is met.
   * Returns { shouldStop: false } if no conditions are met or stopWhen is not defined.
   */
  shouldStop(options?: { totalCostUsd?: number; sessionDurationMs?: number }): { shouldStop: boolean; reason?: string } {
    const prd = this.getPRD();
    const stopWhen = prd.stopWhen;
    if (!stopWhen) {
      return { shouldStop: false };
    }

    // Check stories condition
    if (stopWhen.stories && stopWhen.stories.length > 0) {
      const allTargeted = stopWhen.stories.every(id => {
        const story = prd.userStories.find(s => s.id === id);
        return story?.passes === true;
      });
      if (allTargeted) {
        return { shouldStop: true, reason: `stopWhen stories condition met: all specified stories complete (${stopWhen.stories.join(', ')})` };
      }
    }

    // Check maxCostUsd condition
    if (stopWhen.maxCostUsd !== undefined && options?.totalCostUsd !== undefined) {
      if (options.totalCostUsd >= stopWhen.maxCostUsd) {
        return { shouldStop: true, reason: `stopWhen maxCostUsd condition met: $${options.totalCostUsd.toFixed(2)} >= $${stopWhen.maxCostUsd}` };
      }
    }

    // Check maxDurationMinutes condition
    if (stopWhen.maxDurationMinutes !== undefined && options?.sessionDurationMs !== undefined) {
      const durationMinutes = options.sessionDurationMs / 60000;
      if (durationMinutes >= stopWhen.maxDurationMinutes) {
        return { shouldStop: true, reason: `stopWhen maxDurationMinutes condition met: ${durationMinutes.toFixed(1)}min >= ${stopWhen.maxDurationMinutes}min` };
      }
    }

    return { shouldStop: false };
  }
}

/**
 * Create a PRD manager instance
 */
export function createPRDManager(directory: string): PRDManager {
  return new PRDManager(directory);
}
