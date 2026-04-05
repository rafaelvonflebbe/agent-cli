/**
 * Monitor data polling — pure data functions with no UI dependencies
 */

import { loadWatchConfig } from './watch-config.js';
import { createPRDManager } from './prd.js';
import { createSessionManager } from './session.js';
import { fileExists } from '../utils/file-utils.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import type { ProjectStatus, UserStory } from './types.js';

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
      const session = await sessionManager.load();
      const iterStr = `${session.currentIteration}`;
      const sessionAge = Date.now() - new Date(session.timestamp).getTime();
      status = sessionAge < STALE_THRESHOLD_MS ? 'running' : 'idle';
      cost = 0;
      lastActivity = relativeTime(session.timestamp);

      return { directory, project, branch, iteration: iterStr, stories, status, cost, lastActivity };
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
