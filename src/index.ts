#!/usr/bin/env node
/**
 * Agent CLI - Main entry point
 */

import { Command } from 'commander';
import { createConfig, type ToolType } from './core/config.js';
import { runAgent } from './core/iterator.js';
import { runInit } from './core/init.js';
import { error, success, info } from './utils/logger.js';
import { fileExistsSync } from './utils/file-utils.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createPRDManager } from './core/prd.js';
import chalk from 'chalk';

// Package info - use __dirname for ES modules compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');
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
  .option('--tool <amp|claude>', 'AI tool to use', 'amp')
  .option('--directory <path>', 'Working directory containing prd.json', process.cwd())
  .option('--dry-run', 'Simulate iterations without spawning tools')
  .option('--init', 'Bootstrap agent-cli files in the target directory and exit')
  .option('--stories <number>', 'Maximum number of stories to complete per run')
  .action(async (maxIterationsStr: string, options: { tool: ToolType; directory: string; dryRun: boolean; init: boolean; stories?: string }) => {
    try {
      // Handle --init mode
      if (options.init) {
        await runInit(options.directory);
        process.exit(0);
      }

      // Parse max iterations
      const maxIterations = parseInt(maxIterationsStr, 10);
      if (isNaN(maxIterations) || maxIterations < 1) {
        error('max_iterations must be a positive integer');
        process.exit(1);
      }

      // Validate tool
      if (!['amp', 'claude'].includes(options.tool)) {
        error(`Invalid tool: ${options.tool}. Must be 'amp' or 'claude'`);
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

      const config = createConfig({
        tool: options.tool,
        directory: options.directory,
        maxIterations,
        dryRun: options.dryRun,
        maxStories,
      });

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

      console.log('');
      info(`Project: ${manager.getProjectName()}`);
      console.log(`  Total stories: ${status.total}`);
      console.log(`  Completed:     ${chalk.green(String(status.completed))}`);
      console.log(`  Pending:       ${chalk.yellow(String(status.incomplete))}`);
      console.log('');

      if (status.allComplete) {
        success('All stories are complete!');
      } else {
        const pending = manager.getPRD().userStories
          .filter(s => !s.passes)
          .sort((a, b) => a.priority - b.priority);
        console.log(chalk.yellow('Pending stories:'));
        for (const story of pending) {
          console.log(`  ${chalk.gray(story.id)} ${story.title} ${chalk.gray(`(priority ${story.priority})`)}`);
        }
        console.log('');
      }

      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      error(`Failed to get status: ${message}`);
      process.exit(1);
    }
  });

program.addCommand(statusCommand);

// Parse command line arguments
program.parseAsync(process.argv).catch((err: unknown) => {
  error(`Failed to parse command line arguments: ${err}`);
  process.exit(1);
});
