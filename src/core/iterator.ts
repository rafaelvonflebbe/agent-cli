/**
 * Agent Iterator - main loop orchestration
 */

import type { AgentConfig, UserStory } from './types.js';
import { resolve } from 'path';
import { createPRDManager, PRDManager } from './prd.js';
import { createArchiver, Archiver } from './archiver.js';
import { createToolRunner, ToolRunner } from './tool-runner.js';
import { validateConfig, isACPProvider } from './config.js';
import { info, success, error, warn, iterationHeader } from '../utils/logger.js';
import { appendText, readText, isPathSafe } from '../utils/file-utils.js';
import { captureGitStatus, diffGitStatus, displayFileChanges, branchExists, getCurrentBranch } from '../utils/git-utils.js';
import type { FileChange } from '../utils/git-utils.js';
import { notifyStoryComplete, isTelegramConfigured } from './telegram.js';
import { formatDuration } from '../utils/format-utils.js';
import chalk from 'chalk';
import { join } from 'path';
import { createWriteStream, type WriteStream } from 'fs';
import { createACPClient, type ACPClient, type ACPEvent, type ACPPromptResult } from './acp-client.js';
import { getACPRegistry } from './acp-registry.js';
import { resolveAcpMcpServers } from './mcp-config.js';
import { resolvePromptFile } from './prompt-resolver.js';
import { SessionStore, createSessionStore, resumeSessionStore } from './session-reducer.js';

/**
 * Agent Iterator class
 */
export class AgentIterator {
  private config: AgentConfig;
  private readonly prdManager: PRDManager;
  private readonly archiver: Archiver;
  private toolRunner: ToolRunner;
  private store: SessionStore | null = null;
  private readonly progressFilePath: string;

  /** ACP client fields — used when tool is an ACP provider */
  private readonly useACP: boolean;
  private acpClient: ACPClient | null = null;
  private acpLogStream: WriteStream | null = null;

  /** SIGINT handler reference for cleanup */
  private sigintHandler: (() => void) | null = null;

  constructor(config: AgentConfig) {
    validateConfig(config);
    this.config = config;
    this.prdManager = createPRDManager(config.directory);
    this.archiver = createArchiver(config.directory);
    this.useACP = config.acp === true || isACPProvider(config.tool);

    if (this.useACP) {
      // Placeholder tool runner — won't be used for ACP path
      this.toolRunner = createToolRunner(
        config.directory, config.tool, config.completionSignal,
        config.sandbox, config.permissionMode, config.projectDirectory,
      );
    } else {
      this.toolRunner = createToolRunner(
        config.directory,
        config.tool,
        config.completionSignal,
        config.sandbox,
        config.permissionMode,
        config.projectDirectory,
      );
    }
    this.progressFilePath = join(config.directory, 'progress.log');
  }

  /**
   * Run the agent loop
   */
  async run(): Promise<void> {
    const mode = this.config.dryRun ? 'DRY-RUN' : 'LIVE';
    const sandboxInfo = this.useACP
      ? ' - FS boundaries: ACP (protocol-level)'
      : this.config.sandbox
        ? ' - Sandbox: Docker'
        : '';
    const storiesLimit = this.config.maxStories ? ` - Stories limit: ${this.config.maxStories}` : '';
    const protocolInfo = this.useACP ? ' (ACP)' : '';
    info(`Starting Agent CLI [${mode}] - Tool: ${this.config.tool}${protocolInfo} - Max iterations: ${this.config.maxIterations}${sandboxInfo}${storiesLimit}`);

    // Check if PRD exists
    if (!this.prdManager.exists()) {
      throw new Error(`PRD file not found in ${this.config.directory}`);
    }

    // Load PRD
    await this.prdManager.load();
    const branchName = this.prdManager.getBranchName();

    // Validate --story IDs against PRD
    if (this.config.storyIds && this.config.storyIds.length > 0) {
      this.validateTargetStories(this.config.storyIds);
      info(`Target stories: ${this.config.storyIds.join(', ')}`);
    }

    // Resolve projectDirectory from PRD (overrides config if set)
    const prdProjectDir = this.prdManager.getPRD().projectDirectory;
    if (prdProjectDir) {
      const resolved = resolve(this.config.directory, prdProjectDir);
      this.config = { ...this.config, projectDirectory: resolved };
      // Re-create tool runner for legacy path with the resolved projectDirectory
      if (!this.useACP) {
        this.toolRunner = createToolRunner(
          this.config.directory,
          this.config.tool,
          this.config.completionSignal,
          this.config.sandbox,
          this.config.permissionMode,
          resolved,
        );
      }
      info(`Project directory: ${resolved}`);
    }

    info(`Project: ${this.prdManager.getProjectName()}`);
    info(`Branch: ${branchName}`);

    // Check if the branch still exists (use projectDirectory for git operations when set)
    const gitDir = this.config.projectDirectory || this.config.directory;
    const exists = await branchExists(branchName, gitDir);
    if (!exists) {
      const newBranch = await this.handleStaleBranch(branchName);
      if (!newBranch) {
        return; // Detached HEAD — cannot continue
      }
      // Auto-updated to new branch, continue below
    }

    // Re-read branch name in case stale branch handler updated it
    const effectiveBranch = this.prdManager.getBranchName();

    // Initialize archive system
    await this.archiver.initialize(effectiveBranch);

    // Detect branch change: compare prd.json branchName with actual git branch
    const currentBranch = await getCurrentBranch(gitDir);
    if (currentBranch && currentBranch !== effectiveBranch) {
      await this.handleBranchChange(effectiveBranch, currentBranch);
    }

    // Handle session: create new or resume existing via SessionStore
    if (this.config.resume) {
      const resumed = await resumeSessionStore(this.config.directory);
      if (!resumed) {
        warn('No previous session found. Starting fresh.');
        this.store = await createSessionStore(this.config.directory, this.config.tool, effectiveBranch);
      } else {
        this.store = resumed;
        const state = this.store.getState();
        const isACPResumed = this.useACP && !!state.acpSessionId;

        await this.store.dispatch({
          type: 'SESSION_RESUMED',
          completedStoryIds: state.completedStoryIds,
          iteration: state.currentIteration,
          acpSessionId: state.acpSessionId,
        });

        if (isACPResumed) {
          info(`Resuming ACP session: ${state.completedStoryIds.length} stories already completed, ACP session ${state.acpSessionId}, starting at iteration ${state.currentIteration + 1}`);
        } else {
          info(`Resuming session: ${state.completedStoryIds.length} stories already completed, starting at iteration ${state.currentIteration + 1}`);
        }
      }
    } else {
      this.store = await createSessionStore(this.config.directory, this.config.tool, effectiveBranch);
    }

    // Register SIGINT handler for graceful shutdown
    this.registerSigintHandler();

    // Track accumulated file changes per story for completion reports
    const storyChanges = new Map<string, FileChange[]>();

    // Main iteration loop (start from resumed iteration if applicable)
    const startIteration = this.store.getState().currentIteration + 1;
    for (let i = startIteration; i <= this.config.maxIterations; i++) {

      try {
        let iterationChanges: FileChange[] = [];

        // Save current story passes state to detect completions
        const passesBefore = new Map<string, boolean>();
        for (const story of this.prdManager.getPRD().userStories) {
          passesBefore.set(story.id, story.passes);
        }

        // Get target story for this iteration
        const targetStory = this.getTargetStory();

        // Capture git status before live iterations (skip in dry-run)
        // Use projectDirectory for git ops when set (that's where the AI tool makes changes)
        const gitWorkDir = this.config.projectDirectory || this.config.directory;
        const gitBefore = this.config.dryRun ? null : await captureGitStatus(gitWorkDir);

        if (this.config.dryRun) {
          await this.runDryIteration(i);
        } else {
          await this.runLiveIteration(i);
        }

        // Reload PRD to get updated status (skip in dry-run to preserve in-memory state)
        if (!this.config.dryRun) {
          await this.prdManager.load();
        }

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
              await this.store!.dispatch({ type: 'STORY_COMPLETED', storyId: story.id });
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
              await this.store!.dispatch({ type: 'STORY_COMPLETED', storyId: story.id });
            }
          }
        }

        // Dispatch iteration finished (non-ACP paths — ACP dispatches inside runACPIteration)
        if (!this.useACP) {
          await this.store!.dispatch({ type: 'ITERATION_FINISHED', iteration: i });
        }

        const state = this.store.getState();

        // Check stopWhen conditions (after story completions, before maxStories)
        const stopResult = this.prdManager.shouldStop({
          totalCostUsd: state.totalCostUsd && state.totalCostUsd > 0 ? state.totalCostUsd : undefined,
          sessionDurationMs: Date.now() - (state.sessionStartTime ?? Date.now()),
        });
        if (stopResult.shouldStop) {
          await this.store.dispatch({ type: 'STOPWHEN_TRIGGERED', reason: stopResult.reason ?? 'Unknown stopWhen condition' });
          await this.cleanupACP();
          const status = this.prdManager.getStatus();
          const totalDuration = formatDuration(Date.now() - (state.sessionStartTime ?? Date.now()));
          warn(`stopWhen triggered: ${stopResult.reason}`);
          info(`Progress: ${status.completed}/${status.total} stories complete.`);
          info(`Total session time: ${totalDuration}`);
          await this.logProgress(
            `STOPWHEN TRIGGERED — ${stopResult.reason}. ` +
            `Overall progress: ${status.completed}/${status.total} stories complete. ` +
            `Total session time: ${totalDuration}`
          );
          return;
        }

        // Check if stories limit has been reached
        const storiesCompletedThisRun = state.storiesCompletedThisRun ?? 0;
        if (this.config.maxStories && storiesCompletedThisRun >= this.config.maxStories) {
          await this.cleanupACP();
          const status = this.prdManager.getStatus();
          const totalDuration = formatDuration(Date.now() - (state.sessionStartTime ?? Date.now()));
          info(`Stories limit reached: ${storiesCompletedThisRun}/${this.config.maxStories} stories completed this run.`);
          info(`Total session time: ${totalDuration}`);
          await this.logProgress(
            `STORIES LIMIT REACHED — ${storiesCompletedThisRun}/${this.config.maxStories} stories completed this run. ` +
            `Overall progress: ${status.completed}/${status.total} stories complete. ` +
            `Total session time: ${totalDuration}`
          );
          return;
        }

        // Check if all target stories are complete (all stories when no --story filter)
        if (this.config.storyIds && this.config.storyIds.length > 0) {
          const allTargetsComplete = this.config.storyIds.every(id => {
            const s = this.prdManager.getPRD().userStories.find(us => us.id.toLowerCase() === id.toLowerCase());
            return s?.passes === true;
          });
          if (allTargetsComplete) {
            await this.handleComplete();
            return;
          }
        } else if (this.prdManager.areAllStoriesComplete()) {
          await this.handleComplete();
          return;
        }

        // Show progress
        const status = this.prdManager.getStatus();
        info(`Iteration ${i} complete. Progress: ${status.completed}/${status.total} stories complete.`);

        // Log iteration to progress.log
        const nextStory = this.getTargetStory();
        const storyInfo = nextStory
          ? `Next incomplete story: ${nextStory.id} "${nextStory.title}" (priority ${nextStory.priority})`
          : this.config.storyIds ? 'All targeted stories complete' : 'All stories complete';
        await this.logProgress(
          `Iteration ${i} — Progress: ${status.completed}/${status.total} stories complete. ${storyInfo}`
        );

        // Wait before next iteration
        if (i < this.config.maxIterations) {
          await this.sleep(this.config.iterationDelay);
        }
      } catch (err) {
        await this.cleanupACP();
        const message = err instanceof Error ? err.message : String(err);
        error(`Iteration ${i} failed: ${message}`);
        throw err;
      }
    }

    // Max iterations reached without completion
    await this.cleanupACP();
    const state = this.store.getState();
    const totalDuration = formatDuration(Date.now() - (state.sessionStartTime ?? Date.now()));
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
   * Validate that targeted story IDs exist in PRD and dependencies are met.
   * @throws Error if any ID is missing or dependencies are unmet
   */
  private validateTargetStories(ids: string[]): void {
    const prd = this.prdManager.getPRD();

    // Case-insensitive lookup: lowercase -> canonical ID
    const canonicalMap = new Map<string, string>();
    for (const s of prd.userStories) {
      canonicalMap.set(s.id.toLowerCase(), s.id);
    }

    for (const id of ids) {
      const canonicalId = canonicalMap.get(id.toLowerCase());
      if (!canonicalId) {
        throw new Error(`Story '${id}' not found in prd.json. Available: ${[...canonicalMap.values()].join(', ')}`);
      }
    }

    for (const id of ids) {
      const canonicalId = canonicalMap.get(id.toLowerCase())!;
      const story = prd.userStories.find(s => s.id === canonicalId)!;
      const unmet = this.prdManager.getUnmetDependencies(story);
      if (unmet.length > 0) {
        throw new Error(`Story '${canonicalId}' has unmet dependencies: ${unmet.join(', ')}`);
      }
      if (story.passes) {
        warn(`Story '${canonicalId}' is already complete — will be skipped`);
      }
    }
  }

  /**
   * Get the target story for the current iteration.
   * When --story is set, returns the next incomplete targeted story (in order).
   * Otherwise falls back to priority-based nextStory.
   */
  private getTargetStory(): UserStory | undefined {
    if (this.config.storyIds && this.config.storyIds.length > 0) {
      const prd = this.prdManager.getPRD();
      for (const id of this.config.storyIds) {
        const story = prd.userStories.find(s => s.id.toLowerCase() === id.toLowerCase());
        if (story && !story.passes) {
          return story;
        }
      }
      // All targeted stories are complete
      return undefined;
    }
    return this.prdManager.getStatus().nextStory;
  }

  /**
   * Build a prompt directive telling the agent which story to work on.
   * Returns null when --story is not set (let agent pick by priority).
   */
  private buildTargetDirective(): string | null {
    if (!this.config.storyIds || this.config.storyIds.length === 0) return null;

    const prd = this.prdManager.getPRD();
    const storyLines = this.config.storyIds
      .map(id => {
        const story = prd.userStories.find(s => s.id.toLowerCase() === id.toLowerCase());
        if (!story || story.passes) return null;
        return `${story.id}: ${story.title}`;
      })
      .filter((line): line is string => line !== null);

    if (storyLines.length === 0) return null;

    const label = storyLines.length === 1 ? 'story' : 'stories';
    return `\n\nIMPORTANT: Work ONLY on the following ${label} this iteration. Do NOT work on any other story regardless of priority.\n\n${storyLines.join('\n')}`;
  }

  /**
   * Run a single live iteration (spawns external tool or uses ACP client)
   */
  private async runLiveIteration(i: number): Promise<void> {
    const story = this.getTargetStory();
    iterationHeader(i, this.config.maxIterations, this.config.tool, story ? { id: story.id, title: story.title, priority: story.priority } : undefined);

    if (this.useACP) {
      await this.runACPIteration(i);
    } else {
      await this.runLegacyIteration(i);
    }
  }

  /**
   * Run a single iteration via the legacy tool-runner (spawn + stdout)
   */
  private async runLegacyIteration(i: number): Promise<void> {
    const directive = this.buildTargetDirective();
    const result = await this.toolRunner.run(i, this.config.maxIterations, directive ? { promptSuffix: directive } : undefined);

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
   * Run a single iteration via the ACP client.
   * Initializes the client on first call, then reuses the connection.
   * Sends the prompt file content as a text block and collects structured results.
   * Persists ACP session ID to .session.json for resumption on interruption.
   */
  private async runACPIteration(i: number): Promise<void> {
    // Initialize or re-initialize the ACP client if needed
    if (!this.acpClient || !this.acpClient.isConnected()) {
      await this.initializeACPClient();
    }

    // Read the prompt file (project-level or global fallback)
    const promptFile = await resolvePromptFile(this.config.directory);
    let promptContent = await readText(promptFile);

    // Append target directive when --story is set
    const directive = this.buildTargetDirective();
    if (directive) {
      promptContent += directive;
    }

    const sessionId = this.acpClient!.getSessionId() ?? undefined;
    const startTime = Date.now();

    const isResumed = this.store?.getState().isResumed ?? false;
    this.acpLogStream?.write(`\n--- Iteration ${i}/${this.config.maxIterations} (${this.config.tool})${isResumed ? ' [resumed]' : ''} ---\n`);

    const result: ACPPromptResult = await this.acpClient!.sendPrompt(sessionId, promptContent);

    const durationMs = Date.now() - startTime;

    // Write summary to log
    if (result.cost) {
      this.acpLogStream?.write(`Cost: $${result.cost.amount.toFixed(4)} ${result.cost.currency}\n`);
    }
    this.acpLogStream?.write(`Duration: ${formatDuration(durationMs)}\n`);
    this.acpLogStream?.write(`Stop reason: ${result.stopReason}\n`);

    // Report cost/duration to CLI
    if (result.cost) {
      info(`Iteration cost: $${result.cost.amount.toFixed(4)} ${result.cost.currency}`);
    }
    info(`Iteration duration: ${formatDuration(durationMs)}`);
    info(`Stop reason: ${result.stopReason}`);

    // Persist ACP session ID + cost/duration via store dispatch.
    // The main loop's ITERATION_FINISHED dispatch will overwrite the iteration counter
    // but accumulate cost/duration additively, so we dispatch here with the ACP data.
    const currentSessionId = this.acpClient!.getSessionId();
    await this.store!.dispatch({
      type: 'ITERATION_FINISHED',
      iteration: i,
      costUsd: result.cost?.amount,
      durationMs,
      acpSessionId: currentSessionId ?? undefined,
    });
  }

  /**
   * Initialize the ACP client: resolve provider, launch agent subprocess,
   * create session with MCP servers, and set up event-driven logging.
   *
   * When resuming an interrupted session that has a saved ACP session ID,
   * uses LoadSession instead of creating a new session. If the session is
   * expired or load fails, falls back to creating a new session with a
   * summary of what happened previously.
   */
  private async initializeACPClient(): Promise<void> {
    const registry = await getACPRegistry();
    const provider = await registry.resolve(this.config.tool);

    this.acpClient = createACPClient();

    const projectDir = this.config.projectDirectory || this.config.directory;

    // Build additionalDirectories for filesystem scope:
    // Include the config directory (where prd.json lives) when it differs from
    // the project directory so agents can read/write both locations.
    const additionalDirectories: string[] = [];
    if (this.config.projectDirectory && this.config.projectDirectory !== this.config.directory) {
      additionalDirectories.push(this.config.directory);
    }

    // Resolve MCP servers from provider defaults, PRD, and project config
    const mcpServers = await resolveAcpMcpServers({
      prd: this.prdManager.getPRD(),
      provider,
      projectDir: this.config.directory,
    });

    // Set up log file for real-time output
    const logPath = join(this.config.directory, '.agent-output.log');
    const isResumed = this.store?.getState().isResumed ?? false;
    this.acpLogStream = createWriteStream(logPath, { flags: isResumed ? 'a' : 'w' });

    // Subscribe to ACP events for logging
    this.acpClient.on((event: ACPEvent) => {
      this.handleACPEvent(event);
    });

    // Launch agent subprocess (handshake only, no session yet)
    info(`ACP: Launching provider '${provider.name}': ${provider.command} ${provider.args.join(' ')}`);
    await this.acpClient.launch(
      {
        command: provider.command,
        args: provider.args,
        cwd: projectDir,
        env: provider.env,
      },
    );

    // Attempt to resume an existing ACP session if available
    const isResumedSession = this.store?.getState().isResumed ?? false;
    if (isResumedSession) {
      const session = this.store!.getState();
      const savedSessionId = session.acpSessionId;

      if (savedSessionId && this.acpClient.getAgentCapabilities()?.loadSession) {
        try {
          info(`ACP: Loading previous session ${savedSessionId}`);
          await this.acpClient.loadSession(savedSessionId, {
            cwd: projectDir,
            mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
            additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
          });

          this.acpLogStream?.write(`\n--- Session Resumed (${savedSessionId}) ---\n`);
          info(`ACP: Successfully resumed session ${savedSessionId}`);
          return;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          warn(`ACP: Failed to load session ${savedSessionId}: ${message}`);
          warn('ACP: Session may have expired. Starting a new session with summary context.');
          // Fall through to create a new session with summary
        }
      } else {
        info('ACP: Agent does not support session loading or no saved session ID. Creating new session with summary.');
      }

      // Create a new session with a summary of previous progress
      const summary = this.buildResumptionSummary(session);
      const sessionId = await this.acpClient.createSession({
        cwd: projectDir,
        mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
        additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
      });

      // Send the summary as the first prompt so the agent has context
      info('ACP: Sending resumption summary to new session');
      this.acpLogStream?.write(`\n--- New Session (resumed from previous run) ---\n`);
      this.acpLogStream?.write(`Previous session summary:\n${summary}\n\n`);

      await this.acpClient.sendPrompt(sessionId, summary);
      return;
    }

    // Normal (non-resume) path: create session with filesystem scope
    await this.acpClient.createSession({
      cwd: projectDir,
      mcpServers: mcpServers.length > 0 ? mcpServers : undefined,
      additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
    });
  }

  /**
   * Build a summary of previous session progress for session resumption.
   * This summary is sent as the first prompt to a new ACP session so the
   * agent understands what was already accomplished.
   */
  private buildResumptionSummary(session: { completedStoryIds: string[]; currentIteration: number; lastStoryId: string | null }): string {
    const prd = this.prdManager.getPRD();
    const lines: string[] = [
      'This is a continuation of a previous session that was interrupted. Here is a summary of progress so far:',
      '',
      `Project: ${prd.project}`,
      `Branch: ${prd.branchName}`,
      `Previous iteration: ${session.currentIteration}`,
    ];

    if (session.completedStoryIds.length > 0) {
      lines.push('');
      lines.push(`Completed stories (${session.completedStoryIds.length}):`);
      for (const id of session.completedStoryIds) {
        const story = prd.userStories.find(s => s.id === id);
        if (story) {
          lines.push(`  - ${story.id}: ${story.title}`);
        }
      }
    }

    if (session.lastStoryId) {
      const lastStory = prd.userStories.find(s => s.id === session.lastStoryId);
      if (lastStory) {
        lines.push('');
        lines.push(`Last story being worked on: ${lastStory.id} "${lastStory.title}"`);
      }
    }

    const pendingStories = prd.userStories
      .filter(s => !s.passes)
      .sort((a, b) => a.priority - b.priority);

    if (pendingStories.length > 0) {
      lines.push('');
      lines.push(`Remaining stories (${pendingStories.length}):`);
      for (const story of pendingStories) {
        lines.push(`  - ${story.id} (priority ${story.priority}): ${story.title}`);
      }
    }

    lines.push('');
    lines.push('Please continue implementing the next highest-priority incomplete story.');

    return lines.join('\n');
  }

  /**
   * Handle ACP events by writing human-readable output to .agent-output.log.
   * Text deltas and tool call summaries are written in real time so the
   * monitor TUI (tail -f) can display them.
   */
  private handleACPEvent(event: ACPEvent): void {
    if (!this.acpLogStream) return;

    switch (event.type) {
      case 'text_delta':
        this.acpLogStream.write(event.text);
        break;

      case 'tool_call':
        this.acpLogStream.write(`\n  Tool: ${event.toolCall.title} (${event.toolCall.toolCallId}) status=${event.toolCall.status}\n`);
        if (event.toolCall.locations?.length) {
          for (const loc of event.toolCall.locations) {
            this.acpLogStream.write(`    Location: ${loc.path}${loc.line ? `:${loc.line}` : ''}\n`);
          }
        }
        if (event.toolCall.diffs.length > 0) {
          for (const diff of event.toolCall.diffs) {
            this.acpLogStream.write(`    Diff: ${diff.path}\n`);
          }
        }
        // File deletion guard: check for deletions outside allowed roots
        this.checkFileDeletionGuard(event.toolCall);
        break;

      case 'tool_call_update':
        if (event.toolCall.status === 'completed' || event.toolCall.status === 'failed') {
          this.acpLogStream.write(`  Tool ${event.toolCall.title}: ${event.toolCall.status}\n`);
        }
        break;

      case 'error':
        this.acpLogStream.write(`\nERROR: ${event.message} (code: ${event.code})\n`);
        break;

      default:
        // Other events (usage, plan, state_change, etc.) are handled by the logger
        break;
    }
  }

  /**
   * Check tool calls for file deletion operations outside allowed roots.
   * Logs warnings to .agent-output.log and progress.log when detected.
   */
  private checkFileDeletionGuard(toolCall: { title: string; locations?: { path: string; line?: number | null }[] }): void {
    const deletionPattern = /delete|remove|rm |unlink|rmdir/i;
    if (!deletionPattern.test(toolCall.title)) return;

    const allowedRoot = this.config.projectDirectory || this.config.directory;
    if (!toolCall.locations?.length) return;

    for (const loc of toolCall.locations) {
      if (!isPathSafe(loc.path, allowedRoot)) {
        const msg = `SECURITY WARNING: Tool "${toolCall.title}" targets path outside project: ${loc.path} (allowed root: ${allowedRoot})`;
        warn(msg);
        this.acpLogStream?.write(`\nWARNING: ${msg}\n`);
        this.logProgress(msg).catch(() => {});
      }
    }
  }

  /**
   * Register a SIGINT handler for graceful shutdown.
   * Saves ACP session ID and session state to .session.json before exiting.
   */
  private registerSigintHandler(): void {
    this.sigintHandler = async () => {
      info('\nInterrupted — saving session state for resumption...');

      const acpSessionId = this.acpClient?.getSessionId() ?? undefined;
      const lastStoryId = this.getTargetStory()?.id ?? null;

      await this.store?.dispatch({
        type: 'SESSION_INTERRUPTED',
        lastStoryId,
        acpSessionId,
      });

      const state = this.store?.getState();

      // Write to progress log
      await this.logProgress(
        `INTERRUPTED at iteration ${state?.currentIteration ?? 0}. ` +
        `Session saved for resumption. ` +
        `${state?.completedStoryIds.length ?? 0} stories completed. ` +
        `ACP session: ${acpSessionId ?? 'n/a'}. ` +
        (lastStoryId ? `Next story: ${lastStoryId}` : 'No next story')
      );

      // Clean up ACP client
      await this.cleanupACP();

      process.exit(130); // 128 + SIGINT(2)
    };

    process.on('SIGINT', this.sigintHandler);
  }

  /**
   * Unregister the SIGINT handler.
   */
  private unregisterSigintHandler(): void {
    if (this.sigintHandler) {
      process.removeListener('SIGINT', this.sigintHandler);
      this.sigintHandler = null;
    }
  }

  /**
   * Clean up ACP client resources: close log stream and agent subprocess.
   * Also unregisters the SIGINT handler.
   */
  private async cleanupACP(): Promise<void> {
    this.unregisterSigintHandler();

    if (this.acpLogStream) {
      const state = this.store?.getState();
      const totalCost = state?.totalCostUsd ?? 0;
      const totalDuration = state?.totalDurationMs ?? 0;

      // Write final summary
      if (totalCost > 0) {
        this.acpLogStream.write(`\nTotal cost: $${totalCost.toFixed(4)}\n`);
      }
      if (totalDuration > 0) {
        this.acpLogStream.write(`Total duration: ${formatDuration(totalDuration)}\n`);
      }
      this.acpLogStream.end();
      this.acpLogStream = null;
    }

    if (this.acpClient) {
      await this.acpClient.close();
      this.acpClient = null;
    }
  }

  /**
   * Run a single dry-run iteration (simulates completion without spawning tools)
   */
  private async runDryIteration(i: number): Promise<void> {
    const story = this.getTargetStory();

    if (!story) {
      const reason = this.config.storyIds ? 'All targeted stories are complete' : 'No eligible story — all remaining stories have unmet dependencies';
      info(`[DRY-RUN] Iteration ${i}: ${reason}.`);
      return;
    }

    iterationHeader(i, this.config.maxIterations, this.config.tool, { id: story.id, title: story.title, priority: story.priority });
    info(`[DRY-RUN] Iteration ${i}: Would pick story ${story.id} "${story.title}" (priority ${story.priority})`);
    info(`[DRY-RUN] Iteration ${i}: Would run tool: ${this.config.tool}`);

    // Simulate completing the story (in-memory only — never persist dry-run state to prd.json)
    info(`[DRY-RUN] Iteration ${i}: Simulating completion of ${story.id}`);
    story.passes = true;
  }

  /**
   * Handle completion
   */
  private async handleComplete(): Promise<void> {
    await this.cleanupACP();

    const state = this.store!.getState();
    const finalStatus = this.prdManager.getStatus();
    const totalDuration = formatDuration(Date.now() - (state.sessionStartTime ?? Date.now()));
    const iteration = state.currentIteration;
    const storiesCompletedThisRun = state.storiesCompletedThisRun ?? 0;
    success('All tasks completed!');
    success(`Completed at iteration ${iteration} of ${this.config.maxIterations}`);
    info(`Total stories: ${finalStatus.total} | Completed: ${finalStatus.completed}`);
    info(`Total session time: ${totalDuration}`);
    if (this.config.maxStories) {
      info(`Stories completed this run: ${storiesCompletedThisRun}/${this.config.maxStories}`);
    }
    // Delete session file on clean exit
    await this.store!.delete();
    await this.logProgress(
      `ALL COMPLETE — Finished at iteration ${iteration}/${this.config.maxIterations}. ` +
      `Total stories: ${finalStatus.total}, Completed: ${finalStatus.completed}` +
      (this.config.maxStories ? `, This run: ${storiesCompletedThisRun}/${this.config.maxStories}` : '') +
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
    // Update branch name in store if available
    if (this.store) {
      await this.store.dispatch({ type: 'BRANCH_CHANGED', newBranch: currentBranch });
    }

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
    if (this.store) {
      await this.store.dispatch({ type: 'BRANCH_CHANGED', newBranch });
    }

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
    const branchName = this.store?.getState().branchName ?? this.prdManager.getBranchName();
    const branchInfo = branchName ? ` [branch: ${branchName}]` : '';
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
    return this.store?.getState().currentIteration ?? 0;
  }

  /**
   * Check if tool is available (legacy tool-runner or ACP provider)
   */
  async isToolAvailable(): Promise<boolean> {
    if (this.useACP) {
      const registry = await getACPRegistry();
      try {
        await registry.resolve(this.config.tool);
        return true;
      } catch {
        return false;
      }
    }
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
