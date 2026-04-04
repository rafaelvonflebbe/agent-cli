/**
 * Configuration management for Agent CLI
 */

import type { AgentConfig, ToolType } from './types.js';

export type { ToolType } from './types.js';

/**
 * Default configuration values
 */
const DEFAULTS = {
  tool: 'amp' as ToolType,
  maxIterations: 10,
  iterationDelay: 2000,
  completionSignal: '<promise>COMPLETE</promise>',
  dryRun: false,
} satisfies Record<string, ToolType | number | string | boolean>;

/**
 * Create an agent configuration with defaults applied
 */
export function createConfig(options: Partial<AgentConfig> = {}): AgentConfig {
  return {
    tool: options.tool ?? DEFAULTS.tool,
    directory: options.directory ?? process.cwd(),
    maxIterations: options.maxIterations ?? DEFAULTS.maxIterations,
    iterationDelay: options.iterationDelay ?? DEFAULTS.iterationDelay,
    completionSignal: options.completionSignal ?? DEFAULTS.completionSignal,
    dryRun: options.dryRun ?? false,
  };
}

/**
 * Validate configuration
 * @throws Error if configuration is invalid
 */
export function validateConfig(config: AgentConfig): void {
  if (!['amp', 'claude'].includes(config.tool)) {
    throw new Error(`Invalid tool: ${config.tool}. Must be 'amp' or 'claude'`);
  }

  if (config.maxIterations < 1) {
    throw new Error(`maxIterations must be at least 1, got ${config.maxIterations}`);
  }

  if (config.iterationDelay < 0) {
    throw new Error(`iterationDelay cannot be negative, got ${config.iterationDelay}`);
  }

  if (!config.completionSignal) {
    throw new Error('completionSignal cannot be empty');
  }
}

/**
 * Get the command and arguments for a specific tool
 */
export function getToolCommand(tool: ToolType): { command: string; args: string[] } {
  switch (tool) {
    case 'amp':
      return {
        command: 'amp',
        args: ['--dangerously-allow-all'],
      };
    case 'claude':
      return {
        command: 'claude',
        args: ['--dangerously-skip-permissions', '--print'],
      };
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

/**
 * Get the prompt file name for a specific tool
 */
export function getPromptFile(tool: ToolType): string {
  return tool === 'amp' ? 'prompt.md' : 'agent-cli.md';
}

/**
 * Export defaults for reference
 */
export const DEFAULT_CONFIG = DEFAULTS;
