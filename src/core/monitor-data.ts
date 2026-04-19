/**
 * Monitor data polling — pure data functions with no UI dependencies
 */

import { loadWatchConfig } from './watch-config.js';
import { createPRDManager } from './prd.js';
import { createSessionManager } from './session.js';
import { fileExists } from '../utils/file-utils.js';
import { join } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import type { ProjectStatus, UserStory, SessionState } from './types.js';

export const POLL_INTERVAL_MS = 2000;
const STALE_THRESHOLD_MS = 30_000;
const AGENT_OUTPUT_LOG = '.agent-output.log';
export const LOG_TAIL_LINES = 50;

/**
 * Format a timestamp into a relative time string
 */
export function relativeTime(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ${diffMin % 60}m ago`;
}

/**
 * Format cost in USD
 */
export function formatCost(cost: number): string {
  if (cost === 0) return '-';
  return `$${cost.toFixed(2)}`;
}

/**
 * Collect status for a single watched directory
 */
export async function collectProjectStatus(directory: string): Promise<ProjectStatus | null> {
  const prdPath = join(directory, 'prd.json');
  if (!(await fileExists(prdPath))) return null;

  let project = 'unknown';
  let branch = '-';
  let stories = '-';
  let status: ProjectStatus['status'] = 'stopped';
  let cost = 0;
  let lastActivity = '-';

  try {
    const manager = createPRDManager(directory);
    const prd = await manager.load();
    project = prd.project;
    branch = prd.branchName || '-';

    const completed = prd.userStories.filter(s => s.passes).length;
    const total = prd.userStories.length;
    stories = `${completed}/${total}`;

    const sessionManager = createSessionManager(directory);
    const sessionExists = await sessionManager.exists();

    if (sessionExists) {
      const session: SessionState = await sessionManager.load();
      const iterStr = `${session.currentIteration}`;
      const sessionAge = Date.now() - new Date(session.timestamp).getTime();
      const isResumed = session.isResumed === true || !!session.acpSessionId;

      if (isResumed && sessionAge < STALE_THRESHOLD_MS) {
        status = 'resumed';
      } else {
        status = sessionAge < STALE_THRESHOLD_MS ? 'running' : 'idle';
      }
      cost = session.totalCostUsd ?? 0;
      lastActivity = relativeTime(session.timestamp);

      return { directory, project, branch, iteration: iterStr, stories, status, cost, lastActivity, isResumed };
    }

    const prdStatus = manager.getStatus();
    status = prdStatus.allComplete ? 'done' : 'stopped';
  } catch {
    status = 'stopped';
  }

  return { directory, project, branch, iteration: '-', stories, status, cost, lastActivity };
}

/**
 * Load stories for a specific project (for detail view)
 */
export async function loadStoriesForProject(directory: string): Promise<UserStory[]> {
  try {
    const manager = createPRDManager(directory);
    const prd = await manager.load();
    return prd.userStories;
  } catch {
    return [];
  }
}

/**
 * Poll all watched directories and return their statuses
 */
export async function pollAllProjects(): Promise<ProjectStatus[]> {
  const config = await loadWatchConfig();
  const statuses = await Promise.all(
    config.directories.map(dir => collectProjectStatus(dir)),
  );
  return statuses.filter((s): s is ProjectStatus => s !== null);
}

/**
 * Read the last N lines of the agent output log for a project
 */
export function readAgentLog(directory: string, lines: number = LOG_TAIL_LINES): string[] {
  try {
    const logPath = join(directory, AGENT_OUTPUT_LOG);
    const content = readFileSync(logPath, 'utf-8');
    const allLines = content.split('\n').filter(l => l.length > 0);
    return allLines.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * Write sample agent output to .agent-output.log for testing.
 * Generates realistic-looking log entries simulating tool calls, text output,
 * iteration markers, and cost/duration summaries.
 */
export function writeTestLogData(directory: string): void {
  const logPath = join(directory, AGENT_OUTPUT_LOG);
  const now = new Date().toISOString();

  const lines = [
    `--- Iteration 1/5 (claude) ---`,
    `  Using: Read prd.json`,
    `Let me read the PRD file to find the next story to implement.`,
    ``,
    `  Using: Read src/index.ts`,
    `Now I need to understand the entry point of the application.`,
    ``,
    `  Using: Grep "function handleInput" src/`,
    `  Using: Read src/core/iterator.ts`,
    `I can see the iterator pattern is already in place. Let me implement the story.`,
    ``,
    `  Using: Edit src/core/monitor-ui.tsx`,
    `  Using: Edit src/core/tmux.ts`,
    `  Using: Bash npm run build`,
    `Build passed successfully.`,
    ``,
    `  Using: Edit prd.json`,
    `All acceptance criteria met. Marking story as complete.`,
    ``,
    `Cost: $0.0423`,
    `Duration: 3m 12s`,
    ``,
    `--- Iteration 2/5 (claude) ---`,
    `  Using: Read prd.json`,
    `Loading PRD to find next incomplete story.`,
    ``,
    `  Using: Read src/core/monitor-data.ts`,
    `  Using: Grep "POLL_INTERVAL" src/`,
    `  Using: Edit src/core/monitor-data.ts`,
    `  Using: Bash npm run build`,
    ``,
    `Cost: $0.0298`,
    `Duration: 2m 45s`,
    ``,
    `--- Iteration 3/5 (claude) ---`,
    `  Using: Read prd.json`,
    `  Using: Read src/core/monitor-ui.tsx`,
    `  Using: Edit src/core/monitor-ui.tsx`,
    `  Using: Bash npm run build`,
    `  Using: Edit prd.json`,
    `Story complete. Moving to next.`,
    ``,
    `Cost: $0.0187`,
    `Duration: 1m 58s`,
    ``,
    `# Test log generated at ${now}`,
  ];

  const content = lines.join('\n') + '\n';
  writeFileSync(logPath, content, 'utf-8');
}
