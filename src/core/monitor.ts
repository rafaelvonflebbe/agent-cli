/**
 * Monitor - Ink-based live-updating TUI for watched projects
 */

import { createElement } from 'react';
import { render } from 'ink';
import { MonitorApp } from './monitor-ui.js';
import { closeAllLogPanes, ensureTmuxSession } from './tmux.js';
import { writeTestLogData, pollAllProjects } from './monitor-data.js';

/**
 * ANSI escape sequences for terminal control
 */
const ANSI = {
  enterAltScreen: '\x1b[?1049h',
  exitAltScreen: '\x1b[?1049l',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

/**
 * Monitor class — manages the Ink TUI lifecycle
 */
export class Monitor {
  private inkInstance: ReturnType<typeof render> | null = null;
  private readonly testLog: boolean;

  constructor(testLog = false) {
    this.testLog = testLog;
  }

  /**
   * Start the monitoring TUI
   */
  async start(): Promise<void> {
    // Auto-start tmux session if available (re-execs inside tmux if needed)
    ensureTmuxSession();

    // Write test log data if requested
    if (this.testLog) {
      const projects = await pollAllProjects();
      for (const project of projects) {
        writeTestLogData(project.directory);
      }
    }

    // Enter alternate screen buffer
    process.stdout.write(ANSI.enterAltScreen + ANSI.hideCursor);

    // Handle graceful shutdown on signals
    const cleanup = () => {
      this.stop();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Start the Ink app
    this.inkInstance = render(createElement(MonitorApp));

    // Wait for the app to exit (user pressed 'q')
    await this.inkInstance.waitUntilExit();

    // Clean exit — restore terminal
    this.stop();
  }

  /**
   * Stop the monitoring TUI and restore terminal state
   */
  stop(): void {
    // Clean up any tmux log panes
    closeAllLogPanes();
    if (this.inkInstance) {
      this.inkInstance.unmount();
      this.inkInstance = null;
    }
    process.stdout.write(ANSI.showCursor + ANSI.exitAltScreen);
  }
}

/**
 * Create and return a Monitor instance
 */
export function createMonitor(testLog = false): Monitor {
  return new Monitor(testLog);
}
