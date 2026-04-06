/**
 * Agent Iterator - main loop orchestration
 */

import type { AgentConfig } from './types.js';
import { resolve } from 'path';
import { createPRDManager, PRDManager } from './prd.js';
import { createArchiver, Archiver } from './archiver.js';
import { createToolRunner, ToolRunner } from './tool-runner.js';
import { createSessionManager, SessionManager } from './session.js';
import { validateConfig } from './config.js';
import { info, success, error, warn, iterationHeader } from '../utils/logger.js';
import { appendText } from '../utils/file-utils.js';
import { captureGitStatus, diffGitStatus, displayFileChanges, branchExists, getCurrentBranch } from '../utils/git-utils.js';
import type { FileChange } from '../utils/git-utils.js';
import { notifyStoryComplete, isTelegramConfigured } from './telegram.js';
import { formatDuration } from '../utils/format-utils.js';
import chalk from 'chalk';
import { join } from 'path';

/**
 * Agent Iterator class
 */
export class AgentIterator {
  private config: AgentConfig;
  private readonly prdManager: PRDManager;
  private readonly archiver: Archiver;
  private toolRunner: ToolRunner;
  private readonly sessionManager: SessionManager;
  private readonly progressFilePath: string;
  private iterationCount: number = 0;
  private storiesCompletedThisRun: number = 0;
  private branchName: string = '';
  private sessionCompletedIds: string[] = [];
  private sessionStartTime: number = 0;

  constructor(config: AgentConfig) {
    validateConfig(config);
    this.config = config;
    this.prdManager = createPRDManager(config.directory);
    this.archiver = createArchiver(config.directory);
    this.toolRunner = createToolRunner(
      config.directory,
      config.tool,
      config.completionSignal,
      config.sandbox,
      config.permissionMode,
      config.projectDirectory
    );
    this.sessionManager = createSessionManager(config.directory);
    this.progressFilePath = join(config.directory, 'progress.log');
  }

  /**
   * Run the agent loop
   */
  async run(): Promise<void> {
    const mode = this.config.dryRun ? 'DRY-RUN' : 'LIVE';
    const sandboxInfo = this.config.sandbox ? ' - Sandbox: ON' : '';
    const storiesLimit = this.config.maxStories ? ` - Stories limit: ${this.config.maxStories}` : '';
    info(`Starting Agent CLI [${mode}] - Tool: ${this.config.tool} - Max iterations: ${this.config.maxIterations}${sandboxInfo}${storiesLimit}`);

    this.sessionStartTime = Date.now();

    // Check if PRD exists
    if (!this.prdManager.exists()) {
      throw new Error(`PRD file not found in ${this.config.directory}`);
    }

    // Load PRD
    await this.prdManager.load();
    this.branchName = this.prdManager.getBranchName();

    // Resolve projectDirectory from PRD (overrides config if set)
    const prdProjectDir = this.prdManager.getPRD().projectDirectory;
    if (prdProjectDir) {
      const resolved = resolve(this.config.directory, prdProjectDir);
      this.config = { ...this.config, projectDirectory: resolved };
      this.toolRunner = createToolRunner(
        this.config.directory,
        this.config.tool,
        this.config.completionSignal,
        this.config.sandbox,
        this.config.permissionMode,
        resolved
      );
      info(`Project directory: ${resolved}`);
    }

    info(`Project: ${this.prdManager.getProjectName()}`);
    info(`Branch: ${this.branchName}`);

    // Check if the branch still exists (use projectDirectory for git operations when set)
    const gitDir = this.config.projectDirectory || this.config.directory;
    const exists = await branchExists(this.branchName, gitDir);
    if (!exists) {
      const newBranch = await this.handleStaleBranch(this.branchName);
      if (!newBranch) {
        return; // Detached HEAD — cannot continue
      }
      // Auto-updated to new branch, continue below
    }

    // Initialize archive system
    await this.archiver.initialize(this.branchName);

    // Detect branch change: compare prd.json branchName with actual git branch
    const currentBranch = await getCurrentBranch(gitDir);
    if (currentBranch && currentBranch !== this.branchName) {
      await this.handleBranchChange(this.branchName, currentBranch);
    }

    // Handle session: create new or resume existing
    if (this.config.resume) {
      const sessionExists = await this.sessionManager.exists();
      if (!sessionExists) {
        warn('No previous session found. Starting fresh.');
        await this.sessionManager.create(this.config.tool, this.branchName);
      } else {
        const session = await this.sessionManager.load();
        this.sessionCompletedIds = session.completedStoryIds;
        this.iterationCount = session.currentIteration;
        info(`Resuming session: ${this.sessionCompletedIds.length} stories already completed, starting at iteration ${this.iterationCount + 1}`);
      }
    } else {
      await this.sessionManager.create(this.config.tool, this.branchName);
    }

    // Track accumulated file changes per story for completion reports
    const storyChanges = new Map<string, FileChange[]>();

    // Main iteration loop (start from resumed iteration if applicable)
    const startIteration = this.iterationCount + 1;
    for (let i = startIteration; i <= this.config.maxIterations; i++) {
      this.iterationCount = i;

      try {
        let iterationChanges: FileChange[] = [];

        // Save current story passes state to detect completions
        const passesBefore = new Map<string, boolean>();
        for (const story of this.prdManager.getPRD().userStories) {
          passesBefore.set(story.id, story.passes);
        }

        // Get target story for this iteration
        const targetStory = this.prdManager.getStatus().nextStory;

        // Capture git status before live iterations (skip in dry-run)
        // Use projectDirectory for git ops when set (that's where the AI tool makes changes)
        const gitWorkDir = this.config.projectDirectory || this.config.directory;
        const gitBefore = this.config.dryRun ? null : await captureGitStatus(gitWorkDir);

        if (this.config.dryRun) {
          await this.runDryIteration(i);
        } else {
          await this.runLiveIteration(i);
        }

        // Reload PRD to get updated status
        await this.prdManager.load();

        // Detect and accumulate file changes (live mode only)
        if (!this.config.dryRun && gitBefore) {
          const gitAfter = await captureGitStatus(gitWorkDir);
          iterationChanges = diffGitStatus(gitBefore, gitAfter);
          displayFileChanges(iterationChanges);

          // Accumulate changes for target story
          if (targetStory) {
            const existing = storyChanges.get(targetStory.id) || [];
            existing.push(...iterationChanges);
            storyChanges.set(targetStory.id, existing);
          }
        }

        // Check for newly completed stories and show reports (live mode only)
        if (!this.config.dryRun) {
          const prd = this.prdManager.getPRD();
          for (const story of prd.userStories) {
            if (story.passes && !passesBefore.get(story.id)) {
              this.storiesCompletedThisRun++;
              this.sessionCompletedIds.push(story.id);
              await this.sessionManager.update({
                currentIteration: i,
                completedStoryIds: [...this.sessionCompletedIds],
                lastStoryId: story.id,
              });
              const changes = storyChanges.get(story.id) || [];
              await this.displayStoryReport(story, changes);

              // Send Telegram notification (optional, no-op if not configured)
              const sent = await notifyStoryComplete(this.prdManager.getProjectName(), story, changes);
              if (isTelegramConfigured()) {
                await this.logProgress(
                  sent
                    ? `Telegram notification sent for story ${story.id}`
                    : `Telegram notification FAILED for story ${story.id}`,
                );
              }

              storyChanges.delete(story.id);
            }
          }
        }

        // In dry-run mode, track story completions from simulated updates
        if (this.config.dryRun) {
          const prd = this.prdManager.getPRD();
          for (const story of prd.userStories) {
            if (story.passes && !passesBefore.get(story.id)) {
              this.storiesCompletedThisRun++;
              this.sessionCompletedIds.push(story.id);
              await this.sessionManager.update({
                currentIteration: i,
                completedStoryIds: [...this.sessionCompletedIds],
                lastStoryId: story.id,
              });
            }
          }
        }

        // Check if stories limit has been reached
        if (this.config.maxStories && this.storiesCompletedThisRun >= this.config.maxStories) {
          const status = this.prdManager.getStatus();
          const totalDuration = formatDuration(Date.now() - this.sessionStartTime);
          info(`Stories limit reached: ${this.storiesCompletedThisRun}/${this.config.maxStories} stories completed this run.`);
          info(`Total session time: ${totalDuration}`);
          await this.logProgress(
            `STORIES LIMIT REACHED — ${this.storiesCompletedThisRun}/${this.config.maxStories} stories completed this run. ` +
            `Overall progress: ${status.completed}/${status.total} stories complete. ` +
            `Total session time: ${totalDuration}`
          );
          return;
        }

        // Check if all stories are complete
        if (this.prdManager.areAllStoriesComplete()) {
          await this.handleComplete();
          return;
        }

        // Show progress
        const status = this.prdManager.getStatus();
        info(`Iteration ${i} complete. Progress: ${status.completed}/${status.total} stories complete.`);

        // Update session with current iteration (even if no story completed)
        await this.sessionManager.update({
          currentIteration: i,
        });

        // Log iteration to progress.log
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
    const totalDuration = formatDuration(Date.now() - this.sessionStartTime);
    warn(`Max iterations (${this.config.maxIterations}) reached without completing all tasks.`);
    const finalStatus = this.prdManager.getStatus();
    info(`Final progress: ${finalStatus.completed}/${finalStatus.total} stories complete.`);
    info(`Total session time: ${totalDuration}`);
    info('Check progress.log for details.');
    await this.logProgress(
      `WARNING: Max iterations (${this.config.maxIterations}) reached without completion. ` +
      `Final progress: ${finalStatus.completed}/${finalStatus.total} stories complete. ` +
      `Total session time: ${totalDuration}`
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

    const story = status.nextStory;
    if (!story) {
      warn(`[DRY-RUN] Iteration ${i}: No eligible story — all remaining stories have unmet dependencies.`);
      return;
    }

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
    const totalDuration = formatDuration(Date.now() - this.sessionStartTime);
    success('All tasks completed!');
    success(`Completed at iteration ${this.iterationCount} of ${this.config.maxIterations}`);
    info(`Total stories: ${finalStatus.total} | Completed: ${finalStatus.completed}`);
    info(`Total session time: ${totalDuration}`);
    if (this.config.maxStories) {
      info(`Stories completed this run: ${this.storiesCompletedThisRun}/${this.config.maxStories}`);
    }
    // Delete session file on clean exit
    await this.sessionManager.delete();
    await this.logProgress(
      `ALL COMPLETE — Finished at iteration ${this.iterationCount}/${this.config.maxIterations}. ` +
      `Total stories: ${finalStatus.total}, Completed: ${finalStatus.completed}` +
      (this.config.maxStories ? `, This run: ${this.storiesCompletedThisRun}/${this.config.maxStories}` : '') +
      `. Total session time: ${totalDuration}`
    );
  }

  /**
   * Handle a stale branch that no longer exists.
   * Detects the current git branch and auto-updates prd.json instead of stopping.
   * Returns the new branch name, or null if in detached HEAD (caller should stop).
   */
  private async handleStaleBranch(branchName: string): Promise<string | null> {
    warn(`Branch '${branchName}' no longer exists!`);

    // Archive the run under the stale branch name
    await this.archiver.archive(branchName);

    // Initialize progress file so we can log to it
    await this.archiver.initProgressFile(branchName);

    // Detect current branch (use projectDirectory for git operations)
    const gitDir = this.config.projectDirectory || this.config.directory;
    const currentBranch = await getCurrentBranch(gitDir);

    if (!currentBranch) {
      // Detached HEAD — cannot continue
      await this.prdManager.updateBranchName('');

      await this.logProgress(
        `STALE BRANCH: Branch '${branchName}' no longer exists. ` +
        `Detected detached HEAD state. Cleared branchName in prd.json and archived the run. Stopping loop.`
      );

      error(`Cannot continue: branch '${branchName}' no longer exists and repository is in detached HEAD state. Update prd.json with a valid branchName to resume.`);
      return null;
    }

    // Migrate incomplete stories to new PRD (completed stories stay in archive)
    const { migrated, archived } = await this.prdManager.migrateIncompleteStories(currentBranch);
    this.branchName = currentBranch;

    if (migrated > 0) {
      info(`Migrated ${migrated} incomplete stories to new branch. ${archived} completed stories archived.`);
    } else {
      info(`All ${archived} stories were complete — nothing to migrate.`);
      await this.prdManager.updateBranchName(currentBranch);
    }

    // Reset progress file for new branch
    await this.archiver.resetProgressFile(currentBranch);

    await this.logProgress(
      `STALE BRANCH: Branch '${branchName}' no longer exists. ` +
      `Auto-updated branchName to '${currentBranch}', archived previous run. ` +
      `Migrated ${migrated} stories, ${archived} completed stories stay in archive. Continuing.`
    );

    info(`Continuing on branch '${currentBranch}'`);
    return currentBranch;
  }

  /**
   * Handle a branch change detected by comparing prd.json branchName
   * with the current git branch. Archives the old run, migrates incomplete
   * stories, and updates prd.json — even if the old branch still exists.
   */
  private async handleBranchChange(oldBranch: string, newBranch: string): Promise<void> {
    warn(`Branch changed: prd.json has '${oldBranch}' but current branch is '${newBranch}'`);

    // Archive the run under the old branch name
    await this.archiver.archive(oldBranch);

    // Migrate incomplete stories to new PRD
    const { migrated, archived } = await this.prdManager.migrateIncompleteStories(newBranch);
    this.branchName = newBranch;

    if (migrated > 0) {
      info(`Migrated ${migrated} incomplete stories to new branch. ${archived} completed stories archived.`);
    } else {
      info(`All ${archived} stories were complete — nothing to migrate.`);
      await this.prdManager.updateBranchName(newBranch);
    }

    // Reset progress file for new branch
    await this.archiver.resetProgressFile(newBranch);

    await this.logProgress(
      `BRANCH CHANGE: '${oldBranch}' → '${newBranch}'. ` +
      `Archived previous run. Migrated ${migrated} stories, ${archived} completed stories stay in archive. Continuing.`
    );

    info(`Continuing on branch '${newBranch}'`);
  }

  /**
   * Display and log a story completion report with accumulated file changes
   */
  private async displayStoryReport(
    story: { id: string; title: string },
    changes: FileChange[]
  ): Promise<void> {
    if (changes.length === 0) return;

    // Display on CLI with chalk colors
    console.log(chalk.cyan(`\n  Story ${story.id} "${story.title}" — File changes:`));
    for (const change of changes) {
      if (change.type === 'removed') {
        console.log(chalk.red(`    - ${change.path} (removed)`));
      } else {
        console.log(chalk.green(`    + ${change.path} (${change.type})`));
      }
    }

    // Append to progress.log
    const lines = [
      `Story ${story.id} "${story.title}" — File changes:`,
      ...changes.map(c => `  ${c.type === 'removed' ? '-' : '+'} ${c.path} (${c.type})`),
    ];
    await this.logProgress(lines.join('\n'));
  }

  /**
   * Append a timestamped entry to progress.log
   */
  private async logProgress(message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const branchInfo = this.branchName ? ` [branch: ${this.branchName}]` : '';
    const entry = `\n[${timestamp}]${branchInfo} ${message}\n`;
    try {
      await appendText(this.progressFilePath, entry);
    } catch {
      warn('Failed to write to progress.log');
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
