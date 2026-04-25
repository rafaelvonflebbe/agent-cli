/**
 * Tmux integration — detect tmux availability and manage split panes
 * for the monitor TUI's live log viewer.
 */

import { execSync, spawnSync } from 'child_process';
import { join } from 'path';
import { resolveDataDirectory } from './data-directory.js';

const AGENT_OUTPUT_LOG = '.agent-output.log';

/** Track which directories currently have open log panes */
const openPanes = new Map<string, string>(); // directory -> paneId

/** Env var set when monitor auto-starts a tmux session */
const TMUX_AUTO_ENV = 'AGENT_CLI_TMUX_AUTO';

/**
 * Check if the process is running inside a tmux session
 */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX;
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
 * Ensure the monitor is running inside a tmux session.
 * If already inside tmux → return true.
 * If tmux is not installed → return false (monitor works without it).
 * If tmux is installed but not in a session → re-exec inside a new/attached session.
 * Returns true if now inside tmux (or already was), false if tmux unavailable.
 */
export function ensureTmuxSession(): boolean {
  // Already inside tmux — nothing to do
  if (isInsideTmux()) return true;

  // No tmux binary — can't auto-start
  if (!isTmuxAvailable()) return false;

  // Check if a session named 'agent-cli' already exists
  let sessionExists = false;
  try {
    execSync('tmux has-session -t agent-cli', { stdio: 'pipe' });
    sessionExists = true;
  } catch {
    // has-session returns non-zero when session doesn't exist
    sessionExists = false;
  }

  // Re-exec the current process inside tmux
  const argv = process.argv;
  const cmd = argv[0];       // node / bun
  const args = argv.slice(1); // e.g. [ '/path/to/agent-cli', 'monitor' ]

  if (sessionExists) {
    // Attach to existing session — this blocks until tmux exits
    spawnSync('tmux', ['attach-session', '-t', 'agent-cli'], { stdio: 'inherit' });
  } else {
    // Create new session — this blocks until tmux exits
    // Set env var so the re-execed process knows it was auto-started
    spawnSync('tmux', ['new-session', '-s', 'agent-cli', cmd, ...args], {
      stdio: 'inherit',
      env: { ...process.env, [TMUX_AUTO_ENV]: '1' },
    });
  }

  // When tmux exits, exit the original process (it never rendered anything)
  process.exit(0);
}

/**
 * Open a tmux split pane running `tail -f` on the project's agent output log.
 * Returns the pane ID if successful, or null on failure.
 */
export function openLogPane(directory: string, projectName: string): string | null {
  if (!isInsideTmux()) return null;

  const dataDir = resolveDataDirectory(directory);
  const logPath = join(dataDir, AGENT_OUTPUT_LOG);

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
    // Capture existing pane IDs before splitting
    const before = new Set(
      execSync("tmux list-panes -F '#{pane_id}'", { encoding: 'utf-8' }).trim().split('\n'),
    );

    // Split horizontally: -d keeps focus on monitor, -p 35 gives log pane 35% width
    const header = `\\033[1;36m── ${projectName} (agent log) ──\\033[0m`;
    execSync(
      `tmux split-pane -h -d -p 35 "echo -e '${header}'; tail -f '${logPath}'"`,
      { stdio: 'pipe' },
    );

    // Find the new pane by diffing pane IDs
    const after = execSync("tmux list-panes -F '#{pane_id}'", { encoding: 'utf-8' }).trim().split('\n');
    const paneId = after.find(id => !before.has(id));

    if (!paneId) return null;

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

/**
 * Get the number of currently open log panes
 */
export function getOpenPaneCount(): number {
  return openPanes.size;
}

/**
 * Check if the monitor auto-started its own tmux session
 * (as opposed to being manually started inside an existing tmux session)
 */
export function wasAutoStarted(): boolean {
  return process.env[TMUX_AUTO_ENV] === '1';
}
