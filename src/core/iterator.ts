/**
 * Agent Iterator - main loop orchestration
 */

import type { AgentConfig } from './types.js';
import { createPRDManager, PRDManager } from './prd.js';
import { createArchiver, Archiver } from './archiver.js';
import { createToolRunner, ToolRunner } from './tool-runner.js';
import { validateConfig } from './config.js';
import { info, success, error, warn, iterationHeader } from '../utils/logger.js';
import { appendText } from '../utils/file-utils.js';
import { captureGitStatus, diffGitStatus, displayFileChanges } from '../utils/git-utils.js';
import type { FileChange } from '../utils/git-utils.js';
import { join } from 'path';

/**
 * Agent Iterator class
 */
export class AgentIterator {
  private readonly config: AgentConfig;
  private readonly prdManager: PRDManager;
  private readonly archiver: Archiver;
  private readonly toolRunner: ToolRunner;
  private readonly progressFilePath: string;
  private iterationCount: number = 0;

  constructor(config: AgentConfig) {
    validateConfig(config);
    this.config = config;
    this.prdManager = createPRDManager(config.directory);
    this.archiver = createArchiver(config.directory);
    this.toolRunner = createToolRunner(
      config.directory,
      config.tool,
      config.completionSignal
    );
    this.progressFilePath = join(config.directory, 'progress.txt');
  }

  /**
   * Run the agent loop
   */
  async run(): Promise<void> {
    const mode = this.config.dryRun ? 'DRY-RUN' : 'LIVE';
    info(`Starting Agent CLI [${mode}] - Tool: ${this.config.tool} - Max iterations: ${this.config.maxIterations}`);

    // Check if PRD exists
    if (!this.prdManager.exists()) {
      throw new Error(`PRD file not found in ${this.config.directory}`);
    }

    // Load PRD
    await this.prdManager.load();
    const branchName = this.prdManager.getBranchName();
    info(`Project: ${this.prdManager.getProjectName()}`);
    info(`Branch: ${branchName}`);

    // Initialize archive system
    await this.archiver.initialize(branchName);

    // Check for archiving (branch change)
    const archiveCheck = await this.archiver.checkAndArchive(branchName);
    if (archiveCheck.archived) {
      info(`Archived previous run: ${archiveCheck.archive?.featureName}`);
    }

    // Main iteration loop
    for (let i = 1; i <= this.config.maxIterations; i++) {
      this.iterationCount = i;

      try {
        let iterationChanges: FileChange[] = [];

        // Capture git status before live iterations (skip in dry-run)
        const gitBefore = this.config.dryRun ? null : await captureGitStatus(this.config.directory);

        if (this.config.dryRun) {
          await this.runDryIteration(i);
        } else {
          await this.runLiveIteration(i);
        }

        // Reload PRD to get updated status
        await this.prdManager.load();

        // Check if all stories are complete
        if (this.prdManager.areAllStoriesComplete()) {
          await this.handleComplete();
          return;
        }

        // Show progress
        const status = this.prdManager.getStatus();
        info(`Iteration ${i} complete. Progress: ${status.completed}/${status.total} stories complete.`);

        // Detect and display file changes (live mode only)
        if (!this.config.dryRun && gitBefore) {
          const gitAfter = await captureGitStatus(this.config.directory);
          iterationChanges = diffGitStatus(gitBefore, gitAfter);
          displayFileChanges(iterationChanges);
        }

        // Log iteration to progress.txt
        const nextStory = status.nextStory;
        const storyInfo = nextStory
          ? `Next incomplete story: ${nextStory.id} "${nextStory.title}" (priority ${nextStory.priority})`
          : 'All stories complete';
        await this.logProgress(
          `Iteration ${i} — Progress: ${status.completed}/${status.total} stories complete. ${storyInfo}`
        );

        // Wait before next iteration
        if (i < this.config.maxIterations) {
          await this.sleep(this.config.iterationDelay);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error(`Iteration ${i} failed: ${message}`);
        throw err;
      }
    }

    // Max iterations reached without completion
    warn(`Max iterations (${this.config.maxIterations}) reached without completing all tasks.`);
    const finalStatus = this.prdManager.getStatus();
    info(`Final progress: ${finalStatus.completed}/${finalStatus.total} stories complete.`);
    info('Check progress.txt for details.');
    await this.logProgress(
      `WARNING: Max iterations (${this.config.maxIterations}) reached without completion. ` +
      `Final progress: ${finalStatus.completed}/${finalStatus.total} stories complete.`
    );
  }

  /**
   * Run a single live iteration (spawns external tool)
   */
  private async runLiveIteration(i: number): Promise<void> {
    const status = this.prdManager.getStatus();
    const story = status.nextStory;
    iterationHeader(i, this.config.maxIterations, this.config.tool, story ? { id: story.id, title: story.title, priority: story.priority } : undefined);

    const result = await this.toolRunner.run(i, this.config.maxIterations);

    // Handle tool execution errors
    if (result.exitCode === -1) {
      error('Tool execution failed. Check if the tool is installed and available.');
      throw new Error('Tool execution failed');
    }

    // Check for completion signal
    if (result.completed) {
      await this.handleComplete();
      return;
    }
  }

  /**
   * Run a single dry-run iteration (simulates completion without spawning tools)
   */
  private async runDryIteration(i: number): Promise<void> {
    const status = this.prdManager.getStatus();

    if (status.allComplete) {
      info(`[DRY-RUN] Iteration ${i}: All stories already complete.`);
      return;
    }

    const story = status.nextStory!;
    iterationHeader(i, this.config.maxIterations, this.config.tool, { id: story.id, title: story.title, priority: story.priority });
    info(`[DRY-RUN] Iteration ${i}: Would pick story ${story.id} "${story.title}" (priority ${story.priority})`);
    info(`[DRY-RUN] Iteration ${i}: Would run tool: ${this.config.tool}`);

    // Simulate completing the story
    info(`[DRY-RUN] Iteration ${i}: Simulating completion of ${story.id}`);
    await this.prdManager.updateStory(story.id, true);
  }

  /**
   * Handle completion
   */
  private async handleComplete(): Promise<void> {
    const finalStatus = this.prdManager.getStatus();
    success('All tasks completed!');
    success(`Completed at iteration ${this.iterationCount} of ${this.config.maxIterations}`);
    info(`Total stories: ${finalStatus.total} | Completed: ${finalStatus.completed}`);
    await this.logProgress(
      `ALL COMPLETE — Finished at iteration ${this.iterationCount}/${this.config.maxIterations}. ` +
      `Total stories: ${finalStatus.total}, Completed: ${finalStatus.completed}`
    );
  }

  /**
   * Append a timestamped entry to progress.txt
   */
  private async logProgress(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const entry = `\n[${timestamp}] ${message}\n`;
    try {
      await appendText(this.progressFilePath, entry);
    } catch {
      warn('Failed to write to progress.txt');
    }
  }

  /**
   * Sleep for a specified duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get the current iteration count
   */
  getIterationCount(): number {
    return this.iterationCount;
  }

  /**
   * Check if tool is available
   */
  async isToolAvailable(): Promise<boolean> {
    return this.toolRunner.isAvailable();
  }
}

/**
 * Create an agent iterator instance
 */
export function createIterator(config: AgentConfig): AgentIterator {
  return new AgentIterator(config);
}

/**
 * Run the agent loop with the given configuration
 */
export async function runAgent(config: AgentConfig): Promise<void> {
  const iterator = createIterator(config);

  // Skip tool availability check in dry-run mode
  if (!config.dryRun) {
    const toolAvailable = await iterator.isToolAvailable();
    if (!toolAvailable) {
      throw new Error(
        `Tool '${config.tool}' is not available. Please install it and ensure it's in your PATH.`
      );
    }
  }

  // Run the loop
  await iterator.run();
}
