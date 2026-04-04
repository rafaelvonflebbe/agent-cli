#!/usr/bin/env node
/**
 * Agent CLI - Main entry point
 */

import { Command } from 'commander';
import { createConfig, type ToolType } from './core/config.js';
import { runAgent } from './core/iterator.js';
import { runInit } from './core/init.js';
import { error, success } from './utils/logger.js';
import { fileExistsSync } from './utils/file-utils.js';
import { join } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

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
  .action(async (maxIterationsStr: string, options: { tool: ToolType; directory: string; dryRun: boolean; init: boolean }) => {
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
      const config = createConfig({
        tool: options.tool,
        directory: options.directory,
        maxIterations,
        dryRun: options.dryRun,
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

// Parse command line arguments
program.parseAsync(process.argv).catch((err: unknown) => {
  error(`Failed to parse command line arguments: ${err}`);
  process.exit(1);
});
