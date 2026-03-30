/**
 * Agent Iterator - main loop orchestration
 */

import type { AgentConfig, ToolResult } from './types.js';
import { createPRDManager, PRDManager } from './prd.js';
import { createArchiver, Archiver } from './archiver.js';
import { createToolRunner, ToolRunner } from './tool-runner.js';
import { validateConfig } from './config.js';
import { info, success, error, warn } from '../utils/logger.js';

/**
 * Agent Iterator class
 */
export class AgentIterator {
  private readonly config: AgentConfig;
  private readonly prdManager: PRDManager;
  private readonly archiver: Archiver;
  private readonly toolRunner: ToolRunner;
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
  }

  /**
   * Run the agent loop
   */
  async run(): Promise<void> {
    info(`Starting Agent CLI - Tool: ${this.config.tool} - Max iterations: ${this.config.maxIterations}`);

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
        // Run the AI tool
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
  }

  /**
   * Handle completion
   */
  private async handleComplete(): Promise<void> {
    const finalStatus = this.prdManager.getStatus();
    success('All tasks completed!');
    success(`Completed at iteration ${this.iterationCount} of ${this.config.maxIterations}`);
    info(`Total stories: ${finalStatus.total} | Completed: ${finalStatus.completed}`);
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

  // Check if tool is available
  const toolAvailable = await iterator.isToolAvailable();
  if (!toolAvailable) {
    throw new Error(
      `Tool '${config.tool}' is not available. Please install it and ensure it's in your PATH.`
    );
  }

  // Run the loop
  await iterator.run();
}
