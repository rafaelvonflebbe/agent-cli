/**
 * Tmux integration — detect tmux availability and manage split panes
 * for the monitor TUI's live log viewer.
 */

import { execSync } from 'child_process';
import { join } from 'path';

const AGENT_OUTPUT_LOG = '.agent-output.log';

/** Track which directories currently have open log panes */
const openPanes = new Map<string, string>(); // directory -> paneId

/**
 * Check if the process is running inside a tmux session
 */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX && !!process.env.TERM?.startsWith('tmux');
}

/**
 * Check if the tmux binary is available on the system
 */
export function isTmuxAvailable(): boolean {
  try {
    execSync('which tmux', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Open a tmux split pane running `tail -f` on the project's agent output log.
 * Returns the pane ID if successful, or null on failure.
 */
export function openLogPane(directory: string, projectName: string): string | null {
  if (!isInsideTmux()) return null;

  const logPath = join(directory, AGENT_OUTPUT_LOG);

  // If a pane is already open for this directory, focus it
  const existingPaneId = openPanes.get(directory);
  if (existingPaneId) {
    try {
      execSync(`tmux select-pane -t ${existingPaneId}`, { stdio: 'pipe' });
      return existingPaneId;
    } catch {
      // Pane may have been closed manually — remove stale ref
      openPanes.delete(directory);
    }
  }

  try {
    // Split horizontally with a header showing the project name
    const header = `\\033[1;36m── ${projectName} (agent log) ──\\033[0m`;
    const cmd = `tmux split-pane -h "echo -e '${header}'; tail -f '${logPath}'"`;
    execSync(cmd, { stdio: 'pipe' });

    // Get the pane ID of the newly created pane (last pane)
    const paneId = execSync("tmux list-panes -F '#{pane_id}' -t !", { encoding: 'utf-8' }).trim();

    openPanes.set(directory, paneId);
    return paneId;
  } catch {
    return null;
  }
}

/**
 * Close a specific log pane by directory
 */
export function closeLogPane(directory: string): boolean {
  const paneId = openPanes.get(directory);
  if (!paneId) return false;

  try {
    execSync(`tmux kill-pane -t ${paneId}`, { stdio: 'pipe' });
    openPanes.delete(directory);
    return true;
  } catch {
    // Pane may already be gone
    openPanes.delete(directory);
    return false;
  }
}

/**
 * Close all open log panes
 */
export function closeAllLogPanes(): number {
  let closed = 0;
  for (const [dir] of openPanes) {
    if (closeLogPane(dir)) closed++;
  }
  openPanes.clear();
  return closed;
}

/**
 * Get the set of directories that currently have open log panes
 */
export function getOpenPaneDirectories(): ReadonlySet<string> {
  return new Set(openPanes.keys());
}
