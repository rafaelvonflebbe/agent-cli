#!/usr/bin/env node
/**
 * Agent CLI - Main entry point
 */

import dotenv from 'dotenv';
import { Command } from 'commander';
import { createConfig, isToolRegistered, getAvailableToolNames, type ToolType, type PermissionMode } from './core/config.js';
import { runAgent } from './core/iterator.js';
import { runInit } from './core/init.js';
import { createSessionManager } from './core/session.js';
import { error, success, info, warn } from './utils/logger.js';
import { fileExistsSync } from './utils/file-utils.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createPRDManager } from './core/prd.js';
import { addDirectory, removeDirectory, listDirectories } from './core/watch-config.js';
import { createMonitor } from './core/monitor.js';
import chalk from 'chalk';
import type { SandboxConfig } from './core/types.js';

// Package info - use __dirname for ES modules compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');
// Load .env from agent-cli installation directory, not cwd (works with npm link)
dotenv.config({ path: join(__dirname, '../.env') });
const packagePath = join(__dirname, '../package.json');
const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));

/**
 * Main CLI
 */
const program = new Command();

program
  .name('agent-cli')
  .description(packageJson.description)
  .version(packageJson.version);

program
  .argument('[max_iterations]', 'Maximum number of iterations', '10')
  .option('--tool <tool>', 'AI tool to use (registered tools: use "list" to see available)', 'claude')
  .option('--directory <path>', 'Working directory containing prd.json', process.cwd())
  .option('--dry-run', 'Simulate iterations without spawning tools')
  .option('--init', 'Bootstrap agent-cli files in the target directory and exit')
  .option('--project-directory <path>', 'Project directory where the AI tool works (cwd for spawned process). Defaults to --directory')
  .option('--stories <number>', 'Maximum number of stories to complete per run')
  .option('--resume', 'Resume from a previous interrupted session')
  .option('--sandbox', 'Run AI tool inside a Docker container for isolation')
  .option('--permission-mode <mode>', 'Permission mode: scoped (default, allowlisted tools only) or yolo (skip all permissions, full access)', 'scoped')
  .option('--acp', 'Force ACP (Agent Client Protocol) mode instead of legacy spawn')
  .option('--story <ids>', 'Run specific story IDs (comma-separated, e.g., US-068,US-070)')
  .action(async (maxIterationsStr: string, options: { tool: ToolType; directory: string; dryRun: boolean; init: boolean; projectDirectory?: string; stories?: string; resume?: boolean; sandbox?: boolean; permissionMode: string; acp?: boolean; story?: string }) => {
    try {
      // Handle --init mode
      if (options.init) {
        await runInit(options.directory, options.projectDirectory);
        process.exit(0);
      }

      // Parse max iterations
      const maxIterations = parseInt(maxIterationsStr, 10);
      if (isNaN(maxIterations) || maxIterations < 1) {
        error('max_iterations must be a positive integer');
        process.exit(1);
      }

      // Validate tool against registry
      if (!isToolRegistered(options.tool)) {
        error(`Unknown tool: '${options.tool}'. Available tools: ${getAvailableToolNames().join(', ')}`);
        process.exit(1);
      }

      // Check if directory exists
      if (!fileExistsSync(options.directory)) {
        error(`Directory not found: ${options.directory}`);
        process.exit(1);
      }

      // Check if prd.json exists
      const prdPath = join(options.directory, 'prd.json');
      if (!fileExistsSync(prdPath)) {
        error(`prd.json not found in: ${options.directory}`);
        error('Please create a prd.json file before running agent-cli');
        process.exit(1);
      }

      // Create config
      let maxStories: number | undefined;
      if (options.stories) {
        maxStories = parseInt(options.stories, 10);
        if (isNaN(maxStories) || maxStories < 1) {
          error('--stories must be a positive integer');
          process.exit(1);
        }
      }

      // Validate permission mode
      if (options.permissionMode !== 'scoped' && options.permissionMode !== 'yolo') {
        error(`--permission-mode must be 'scoped' or 'yolo', got '${options.permissionMode}'`);
        process.exit(1);
      }
      const permissionMode: PermissionMode = options.permissionMode;

      // Parse --story flag (comma-separated IDs)
      let storyIds: string[] | undefined;
      if (options.story) {
        storyIds = options.story.split(',').map(s => s.trim()).filter(Boolean);
        if (storyIds.length === 0) {
          error('--story must contain at least one story ID');
          process.exit(1);
        }
      }

      const config = createConfig({
        tool: options.tool,
        directory: options.directory,
        projectDirectory: options.projectDirectory,
        maxIterations,
        dryRun: options.dryRun,
        maxStories,
        resume: options.resume,
        sandbox: options.sandbox ? { image: 'agent-cli-runner' } satisfies SandboxConfig : undefined,
        permissionMode,
        acp: options.acp,
        storyIds,
      });

      // Check for existing session
      const sessionManager = createSessionManager(options.directory);
      const sessionExists = await sessionManager.exists();

      if (sessionExists && !options.resume) {
        const session = await sessionManager.load();
        const count = session.completedStoryIds.length;
        warn(`Previous session found (${count} stories completed). Use --resume to continue from where you left off.`);
      }

      // Run the agent
      await runAgent(config);

      success('Agent CLI completed successfully');
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Agent CLI failed: ${message}`);
      process.exit(1);
    }
  });

/**
 * Status subcommand - show completed and pending stories
 */
const statusCommand = new Command('status');
statusCommand
  .description('Show completed and pending stories from prd.json')
  .option('-d, --dir <path>', 'Working directory containing prd.json', process.cwd())
  .action(async (options: { dir: string }) => {
    try {
      const directory = options.dir;
      const prdPath = join(directory, 'prd.json');
      if (!fileExistsSync(prdPath)) {
        error(`prd.json not found in: ${directory}`);
        process.exit(1);
      }

      const manager = createPRDManager(directory);
      await manager.load();
      const status = manager.getStatus();

      const stories = manager.getPRD().userStories;
      const completed = stories.filter(s => s.passes).sort((a, b) => a.priority - b.priority);
      const pending = stories.filter(s => !s.passes).sort((a, b) => a.priority - b.priority);
      const ordered = [...completed, ...pending];

      const statusIcon = (done: boolean) => done ? chalk.green('✔') : chalk.yellow('●');
      const colStatus = 4;
      const colId = 8;
      const colPri = 9;
      const colTitle = 40;
      const colCriteria = 18;

      const header = [
        'Stat'.padEnd(colStatus),
        'ID'.padEnd(colId),
        'Priority'.padEnd(colPri),
        'Title'.padEnd(colTitle),
        'Criteria'.padEnd(colCriteria),
      ].join(' ');
      const separator = '─'.repeat(header.length);

      console.log('');
      info(`Project: ${manager.getProjectName()}`);
      console.log(chalk.gray(separator));
      console.log(chalk.bold(header));
      console.log(chalk.gray(separator));

      for (const story of ordered) {
        const icon = statusIcon(story.passes);
        const id = story.id.padEnd(colId);
        const pri = String(story.priority).padEnd(colPri);
        const title = story.title.length > colTitle - 1
          ? story.title.slice(0, colTitle - 2) + '…'
          : story.title.padEnd(colTitle);
        const criteria = `${story.acceptanceCriteria.length} criteria`.padEnd(colCriteria);
        console.log(`${icon}  ${id} ${pri} ${title} ${criteria}`);

        // Show blocked-by info for pending stories with unmet dependencies
        if (!story.passes && story.dependsOn && story.dependsOn.length > 0) {
          const unmet = manager.getUnmetDependencies(story);
          if (unmet.length > 0) {
            console.log(chalk.gray(`     blocked by: ${unmet.join(', ')}`));
          }
        }
      }

      console.log(chalk.gray(separator));
      console.log(
        chalk.green(`${completed.length} completed`) +
        '  ' +
        chalk.yellow(`${pending.length} pending`) +
        '  ' +
        chalk.gray(`${status.total} total`),
      );
      console.log('');

      if (status.allComplete) {
        success('All stories are complete!');
      }

      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Failed to get status: ${message}`);
      process.exit(1);
    }
  });

program.addCommand(statusCommand);

/**
 * Watch subcommand - manage monitored directories
 */
const watchCommand = new Command('watch');
watchCommand
  .description('Manage monitored project directories')
  .option('--add <path>', 'Add a directory to the watch list')
  .option('--remove <path>', 'Remove a directory from the watch list')
  .action(async (options: { add?: string; remove?: string }) => {
    try {
      if (options.add && options.remove) {
        error('Cannot use --add and --remove together');
        process.exit(1);
      }

      if (options.add) {
        await addDirectory(options.add);
      } else if (options.remove) {
        await removeDirectory(options.remove);
      } else {
        await listDirectories();
      }

      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Failed: ${message}`);
      process.exit(1);
    }
  });

program.addCommand(watchCommand);

/**
 * Monitor subcommand - live-updating table of watched projects
 */
const monitorCommand = new Command('monitor');
monitorCommand
  .description('Show live-updating status table for watched projects')
  .option('--test-log', 'Write sample agent output to .agent-output.log for each watched project')
  .action(async (options: { testLog?: boolean }) => {
    try {
      const monitor = createMonitor(options.testLog);
      await monitor.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Monitor failed: ${message}`);
      process.exit(1);
    }
  });

program.addCommand(monitorCommand);

// Parse command line arguments
program.parseAsync(process.argv).catch((err: unknown) => {
  error(`Failed to parse command line arguments: ${err}`);
  process.exit(1);
});
